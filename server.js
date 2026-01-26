/**
 * Presence Media / Signaling Server
 * ICE-SAFE – Android/Web compatible
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;

// sessionId → { a, b, sdpReady: Map<ws,bool>, iceQueue: Map<ws,[]> }
const sessions = new Map();

/* ───────── UTILS ───────── */

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(" ")}\n`);
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
  const s = sessions.get(ws.sessionId);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
}

function cleanup(ws) {
  const s = sessions.get(ws.sessionId);
  if (!s) return;

  s.sdpReady.delete(ws);
  s.iceQueue.delete(ws);

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

/* ───────── WEBSOCKET ───────── */

const wss = new WebSocketServer({
  server,
  path: "/ws",
});

wss.on("connection", (ws, req) => {
  ws.id = uid();
  ws.sessionId = null;
  ws.isAlive = true;

  log("WS_CONNECT", ws.id);

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "join": {
        const id = msg.address || msg.linkToken;
        if (!id) return;

        ws.sessionId = id;

        let s = sessions.get(id);
        if (!s) {
          s = {
            a: ws,
            b: null,
            sdpReady: new Map(),
            iceQueue: new Map(),
          };
          sessions.set(id, s);
          return;
        }

        if (!s.b) {
          s.b = ws;

          s.sdpReady.set(s.a, false);
          s.sdpReady.set(s.b, false);

          s.iceQueue.set(s.a, []);
          s.iceQueue.set(s.b, []);

          safeSend(s.a, { type: "ready", role: "initiator" });
          safeSend(s.b, { type: "ready", role: "polite" });
        }
        break;
      }

      case "webrtc_offer":
      case "webrtc_answer": {
        const peer = getPeer(ws);
        if (!peer) return;

        safeSend(peer, msg);

        // Mark SDP ready for sender
        const s = sessions.get(ws.sessionId);
        s.sdpReady.set(ws, true);

        // Flush queued ICE to sender
        const queued = s.iceQueue.get(ws) || [];
        queued.forEach((c) => safeSend(ws, c));
        s.iceQueue.set(ws, []);

        break;
      }

      case "webrtc_ice": {
        const peer = getPeer(ws);
        if (!peer) return;

        const s = sessions.get(ws.sessionId);
        if (!s.sdpReady.get(peer)) {
          s.iceQueue.get(peer).push(msg);
          return;
        }

        safeSend(peer, msg);
        break;
      }

      case "collapse": {
        const peer = getPeer(ws);
        if (peer) safeSend(peer, { type: "collapse", reason: "peer_exit" });
        cleanup(ws);
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
