/**
 * Presence Media / Signaling Server
 * FINAL – SDP-safe, role-aware, no premature collapse
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

/* ───────────────── CONFIG ───────────────── */

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;

/* ───────────────── STATE ───────────────── */

// sessionId → { a: ws|null, b: ws|null }
const sessions = new Map();

/* ───────────────── LOGGING ───────────────── */

function log(...args) {
  process.stdout.write(
    `[${new Date().toISOString()}] ${args.join(" ")}\n`
  );
}

function uid() {
  return crypto.randomUUID();
}

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getPeer(ws) {
  if (!ws.sessionId) return null;
  const s = sessions.get(ws.sessionId);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
}

function cleanup(ws) {
  if (!ws.sessionId) return;

  const s = sessions.get(ws.sessionId);
  if (!s) return;

  if (s.a === ws) s.a = null;
  if (s.b === ws) s.b = null;

  if (!s.a && !s.b) {
    sessions.delete(ws.sessionId);
    log("SESSION_REMOVED", ws.sessionId);
  }
}

/* ───────────────── HTTP ───────────────── */

const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end("Presence signaling server alive");
});

/* ───────────────── WEBSOCKET ───────────────── */

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.id = uid();
  ws.sessionId = null;
  ws.isAlive = true;

  log("WS_CONNECT", ws.id, req.socket.remoteAddress ?? "");

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log("BAD_JSON", ws.id);
      return;
    }

    log("MSG", ws.id, msg.type);

    switch (msg.type) {
      /* ───────── JOIN ───────── */

      case "join": {
        const sessionId = msg.address || msg.linkToken;
        if (!sessionId) return;

        ws.sessionId = sessionId;

        let s = sessions.get(sessionId);
        if (!s) {
          sessions.set(sessionId, { a: ws, b: null });
          log("SESSION_CREATED", sessionId, "A=", ws.id);
          return;
        }

        if (!s.b) {
          s.b = ws;
          log("SESSION_READY", sessionId, "A=", s.a.id, "B=", ws.id);

          safeSend(s.a, { type: "ready", role: "initiator" });
          safeSend(s.b, { type: "ready", role: "polite" });
        }
        break;
      }

      /* ───────── HEARTBEAT ───────── */

      case "ping":
        safeSend(ws, { type: "pong" });
        break;

      /* ───────── RELAY ───────── */

      case "webrtc_offer":
      case "webrtc_answer":
      case "webrtc_ice":
      case "text":
      case "hold":
      case "clear":
      case "reveal_frame": {
        const peer = getPeer(ws);
        if (!peer) return;
        safeSend(peer, msg);
        break;
      }

      /* ───────── EXPLICIT COLLAPSE ───────── */

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
    }
  });

  ws.on("close", () => {
    log("WS_CLOSE", ws.id);
    const peer = getPeer(ws);
    if (peer) {
      safeSend(peer, {
        type: "collapse",
        reason: "peer_lost",
      });
    }
    cleanup(ws);
  });

  ws.on("error", (e) => {
    log("WS_ERROR", ws.id, e.message);
  });
});

/* ───────────────── HEARTBEAT SWEEP ───────────────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log("TERMINATE", ws.id);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

/* ───────────────── START ───────────────── */

server.listen(PORT, () => {
  log("SERVER_STARTED", PORT);
});
