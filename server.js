/**
 * Presence Media / Signaling Server
 * AUTHORITATIVE – deterministic obstruction + collapse
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;
const COLLAPSE_GRACE_SECONDS = 10;

/**
 * sessionId → {
 *   a: WebSocket | null,
 *   b: WebSocket | null,
 *   obstructionActive: boolean,
 *   obstructionTimer: Timeout | null
 * }
 */
const sessions = new Map();

/* ───────────────── UTILS ───────────────── */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function uid() {
  return crypto.randomUUID();
}

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getSession(ws) {
  return ws.sessionId ? sessions.get(ws.sessionId) ?? null : null;
}

function getPeer(ws) {
  const s = getSession(ws);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
}

/* ───────────────── SOFT OBSTRUCTION (FIXED) ───────────────── */

function startObstruction(actor, reason) {
  const s = getSession(actor);
  if (!s) return;

  // 🔒 HARD GUARD — already obstructed
  if (s.obstructionActive) return;

  const peer = getPeer(actor);
  if (!peer) return;

  s.obstructionActive = true;

  log("PEER_OBSTRUCTED", peer.id, reason);

  safeSend(peer, {
    type: "peer_obstructed",
    seconds: COLLAPSE_GRACE_SECONDS,
    reason,
  });

  s.obstructionTimer = setTimeout(() => {
    if (!s.obstructionActive) return;

    log("GRACE_EXPIRED", actor.sessionId);

    safeSend(peer, {
      type: "collapse_grace_elapsed",
      reason: "grace_elapsed",
    });

    hardCollapse(actor, "grace_elapsed");
  }, COLLAPSE_GRACE_SECONDS * 1000);
}

function cancelObstruction(actor) {
  const s = getSession(actor);
  if (!s) return;

  if (!s.obstructionActive) return;

  s.obstructionActive = false;

  if (s.obstructionTimer) {
    clearTimeout(s.obstructionTimer);
    s.obstructionTimer = null;
  }

  const peer = getPeer(actor);
  if (peer) {
    safeSend(peer, { type: "peer_restored" });
  }

  log("PEER_RESTORED", actor.id);
}

/* ───────────────── HARD COLLAPSE ───────────────── */

function hardCollapse(ws, reason) {
  const s = getSession(ws);
  if (!s) return;

  if (s.obstructionTimer) {
    clearTimeout(s.obstructionTimer);
    s.obstructionTimer = null;
  }

  s.obstructionActive = false;

  const peer = getPeer(ws);
  if (peer) {
    safeSend(peer, {
      type: "collapse_hard",
      reason,
    });
  }

  cleanup(ws);
}

/* ───────────────── CLEANUP ───────────────── */

function cleanup(ws) {
  const s = getSession(ws);
  if (!s) return;

  cancelObstruction(ws);

  if (s.a === ws) s.a = null;
  if (s.b === ws) s.b = null;

  if (!s.a && !s.b) {
    sessions.delete(ws.sessionId);
    log("SESSION_REMOVED", ws.sessionId);
  }
}

/* ───────────────── HTTP ───────────────── */

const server = http.createServer((_, res) => {
  res.end("Presence signaling server alive");
});

/* ───────────────── WEBSOCKET ───────────────── */

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.id = uid();
  ws.sessionId = null;
  ws.isAlive = true;

  log("WS_CONNECT", ws.id);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "join": {
        const sessionId = msg.address || msg.linkToken;
        if (!sessionId) return;

        ws.sessionId = sessionId;

        let s = sessions.get(sessionId);
        if (!s) {
          s = {
            a: ws,
            b: null,
            obstructionActive: false,
            obstructionTimer: null,
          };
          sessions.set(sessionId, s);
          return;
        }

        if (!s.b) {
          s.b = ws;
          safeSend(s.a, { type: "ready", role: "initiator" });
          safeSend(s.b, { type: "ready", role: "polite" });
        }
        break;
      }

      case "peer_obstructed": {
        startObstruction(ws, msg.reason ?? "peer_obstructed");
        break;
      }

      case "peer_restored": {
        cancelObstruction(ws);
        break;
      }

      case "collapse_hard": {
        hardCollapse(ws, msg.reason ?? "hard_violation");
        break;
      }

      default: {
        const peer = getPeer(ws);
        if (peer) safeSend(peer, msg);
      }
    }
  });

  ws.on("close", () => {
    log("WS_CLOSE", ws.id);
    hardCollapse(ws, "socket_closed");
  });
});

/* ───────────────── HEARTBEAT ───────────────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log("WS_TIMEOUT", ws.id);
      hardCollapse(ws, "heartbeat_timeout");
      ws.terminate();
      return;
    }

    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

/* ───────────────── START ───────────────── */

server.listen(PORT, "0.0.0.0", () => {
  log("SERVER_STARTED", PORT);
});
