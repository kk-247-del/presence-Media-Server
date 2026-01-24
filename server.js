/**
 * Locus Presence Signaling Server
 * Railway-compatible
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

/* ───────────────── CONFIG ───────────────── */

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;

/* ───────────────── STATE ───────────────── */

const sessions = new Map(); // sessionId -> { a, b }
const knocks = new Map();   // knockName -> ws

/* ───────────────── HELPERS ───────────────── */

function uid() {
  return crypto.randomUUID();
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/* ───────────────── HTTP SERVER ───────────────── */

const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end("Presence signaling server alive");
});

/* ───────────────── WEBSOCKET ───────────────── */

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.id = uid();
  ws.sessionId = null;
  ws.knockName = null;
  ws.isAlive = true;

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
      /* ───── PRESENCE ───── */

      case "join": {
        const sessionId = msg.address || msg.linkToken;
        if (!sessionId) return;

        ws.sessionId = sessionId;

        let s = sessions.get(sessionId);
        if (!s) {
          s = { a: ws, b: null };
          sessions.set(sessionId, s);
          return;
        }

        if (!s.b) {
          s.b = ws;

          safeSend(s.a, { type: "ready" });
          safeSend(s.b, { type: "ready" });
        }
        break;
      }

      case "ping":
        safeSend(ws, { type: "pong" });
        break;

      /* ───── RELAY ───── */

      case "text":
      case "hold":
      case "clear":
      case "reveal_frame": {
        const peer = getPeer(ws);
        if (peer) safeSend(peer, msg);
        break;
      }

      /* ───── COLLAPSE ───── */

      case "collapse": {
        const peer = getPeer(ws);
        if (peer) safeSend(peer, { type: "collapse", reason: msg.reason });
        cleanup(ws);
        break;
      }

      /* ───── KNOCK SYSTEM ───── */

      case "register_knock":
        ws.knockName = msg.name;
        knocks.set(msg.name, ws);
        break;

      case "knock_response": {
        const target = knocks.get(msg.id);
        if (target) safeSend(target, msg);
        break;
      }
    }
  });

  ws.on("close", () => {
    const peer = getPeer(ws);
    if (peer) safeSend(peer, { type: "collapse", reason: "peer_lost" });
    cleanup(ws);
  });
});

/* ───────────────── UTIL ───────────────── */

function getPeer(ws) {
  if (!ws.sessionId) return null;
  const s = sessions.get(ws.sessionId);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
}

function cleanup(ws) {
  if (ws.sessionId) {
    const s = sessions.get(ws.sessionId);
    if (s) {
      if (s.a === ws) s.a = null;
      if (s.b === ws) s.b = null;
      if (!s.a && !s.b) sessions.delete(ws.sessionId);
    }
  }

  if (ws.knockName) {
    knocks.delete(ws.knockName);
  }
}

/* ───────────────── HEARTBEAT ───────────────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

/* ───────────────── START ───────────────── */

server.listen(PORT, () => {
  console.log(`Presence server running on ${PORT}`);
});
