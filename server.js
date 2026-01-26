/**
 * Presence Media / Signaling Server
 * FIXED – explicit /ws path, Railway-safe
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;

// sessionId → { a: ws|null, b: ws|null }
const sessions = new Map();

/* ───────── LOGGING ───────── */

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

/* ───────── HTTP ───────── */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    return res.end("OK");
  }
  res.writeHead(200);
  res.end("Presence signaling server alive");
});

/* ───────── WEBSOCKET (/ws) ───────── */

const wss = new WebSocketServer({
  server,
  path: "/ws", // 🔑 REQUIRED for Flutter Web
});

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
      return;
    }

    switch (msg.type) {
      case "join": {
        const sessionId = msg.address || msg.linkToken;
        if (!sessionId) return;

        ws.sessionId = sessionId;
        let s = sessions.get(sessionId);

        if (!s) {
          sessions.set(sessionId, { a: ws, b: null });
          return;
        }

        if (!s.b) {
          s.b = ws;
          safeSend(s.a, { type: "ready", role: "initiator" });
          safeSend(s.b, { type: "ready", role: "polite" });
        }
        break;
      }

      case "ping":
        safeSend(ws, { type: "pong" });
        break;

      case "webrtc_offer":
      case "webrtc_answer":
      case "webrtc_ice":
      case "text":
      case "hold":
      case "clear": {
        const peer = getPeer(ws);
        if (peer) safeSend(peer, msg);
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
    }
  });

  ws.on("close", () => {
    const peer = getPeer(ws);
    if (peer) {
      safeSend(peer, { type: "collapse", reason: "peer_lost" });
    }
    cleanup(ws);
  });
});

/* ───────── HEARTBEAT ───────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

/* ───────── START ───────── */

server.listen(PORT, "0.0.0.0", () => {
  log("SERVER_STARTED", PORT);
});
