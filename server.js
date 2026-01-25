/**
 * Presence Media / Signaling Server
 * Pure WebSocket relay (no Dart, no Flutter)
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

/* ───────────────── CONFIG ───────────────── */

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;
const SDP_TIMEOUT_MS = 15000;

/* ───────────────── STATE ───────────────── */

// sessionId -> { a, b, sdpStarted, sdpTimer }
const sessions = new Map();

/* ───────────────── LOGGING ───────────────── */

function log(...args) {
  process.stdout.write(
    `[${new Date().toISOString()}] ${args.join(" ")}\n`
  );
}

/* ───────────────── HELPERS ───────────────── */

function uid() {
  return crypto.randomUUID();
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
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

  if (s.sdpTimer) clearTimeout(s.sdpTimer);

  if (s.a === ws) s.a = null;
  if (s.b === ws) s.b = null;

  if (!s.a && !s.b) {
    sessions.delete(ws.sessionId);
    log("SESSION_REMOVED", ws.sessionId);
  }
}

/* ───────────────── HTTP SERVER ───────────────── */

const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end("Presence media server alive");
});

/* ───────────────── WEBSOCKET SERVER ───────────────── */

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
      case "join": {
        const sessionId = msg.address || msg.linkToken;
        if (!sessionId) return;

        ws.sessionId = sessionId;

        let s = sessions.get(sessionId);
        if (!s) {
          s = { a: ws, b: null, sdpStarted: false, sdpTimer: null };
          sessions.set(sessionId, s);
          log("SESSION_CREATED", sessionId, "A=", ws.id);
          return;
        }

        if (!s.b) {
          s.b = ws;
          log("SESSION_READY", sessionId);

          safeSend(s.a, { type: "ready" });
          safeSend(s.b, { type: "ready" });

          s.sdpTimer = setTimeout(() => {
            if (!s.sdpStarted) {
              log("SDP_TIMEOUT", sessionId);
              safeSend(s.a, { type: "collapse", reason: "sdp_timeout" });
              safeSend(s.b, { type: "collapse", reason: "sdp_timeout" });
              cleanup(s.a);
              cleanup(s.b);
            }
          }, SDP_TIMEOUT_MS);
        }
        break;
      }

      case "ping":
        safeSend(ws, { type: "pong" });
        break;

      case "webrtc_offer":
      case "webrtc_answer":
      case "webrtc_ice": {
        const peer = getPeer(ws);
        if (!peer) return;

        const s = sessions.get(ws.sessionId);
        if (s && !s.sdpStarted) {
          s.sdpStarted = true;
          log("SDP_STARTED", ws.sessionId);
        }

        log("RELAY", msg.type, ws.id, "→", peer.id);
        safeSend(peer, msg);
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

      default:
        log("UNKNOWN_TYPE", ws.id, msg.type);
    }
  });

  ws.on("close", () => {
    log("WS_CLOSE", ws.id);
    const peer = getPeer(ws);
    if (peer) {
      safeSend(peer, { type: "collapse", reason: "peer_lost" });
    }
    cleanup(ws);
  });
});

/* ───────────────── HEARTBEAT ───────────────── */

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
