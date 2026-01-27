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

// sessionId → { a, b, timers: Map<ws, Timeout> }
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
  if (!ws.sessionId) return null;
  return sessions.get(ws.sessionId) ?? null;
}

function getPeer(ws) {
  const s = getSession(ws);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
}

/* ───────────────── COLLAPSE CONTROL ───────────────── */

function startObstruction(ws, reason) {
  const peer = getPeer(ws);
  if (!peer) return;

  const s = getSession(ws);
  if (!s) return;

  // prevent duplicate obstruction
  if (s.timers.has(peer)) return;

  log("PEER_OBSTRUCTED", peer.id, reason);

  safeSend(peer, {
    type: "peer_obstructed",
    seconds: COLLAPSE_GRACE_SECONDS,
    reason,
  });

  const timer = setTimeout(() => {
    safeSend(peer, {
      type: "collapse",
      reason: "grace_elapsed",
    });
    cleanup(peer);
  }, COLLAPSE_GRACE_SECONDS * 1000);

  s.timers.set(peer, timer);
}

function cancelObstruction(ws) {
  const s = getSession(ws);
  if (!s) return;

  const timer = s.timers.get(ws);
  if (timer) {
    clearTimeout(timer);
    s.timers.delete(ws);

    safeSend(ws, { type: "peer_restored" });
    log("PEER_RESTORED", ws.id);
  }
}

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
          s = { a: ws, b: null, timers: new Map() };
          sessions.set(sessionId, s);
          return;
        }

        if (!s.b) {
          s.b = ws;

          // 🔑 AUTHORITATIVE ROLES
          safeSend(s.a, { type: "ready", role: "initiator" });
          safeSend(s.b, { type: "ready", role: "polite" });
        }
        break;
      }

      case "collapse": {
        const peer = getPeer(ws);
        if (peer) {
          safeSend(peer, {
            type: "collapse",
            reason: msg.reason ?? "peer_exit",
          });
        }
        cleanup(ws);
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
    startObstruction(ws, "peer_lost");
    cleanup(ws);
  });
});

/* ───────────────── HEARTBEAT ───────────────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log("WS_TIMEOUT", ws.id);
      startObstruction(ws, "heartbeat_timeout");
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

/* ───────────────── START ───────────────── */

server.listen(PORT, "0.0.0.0", () => {
  log("SERVER_STARTED", PORT);
});
