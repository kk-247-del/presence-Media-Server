/**
 * Presence Media / Signaling Server
 * Railway-compatible, log-safe, WebSocket-first
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

/* ───────────────── CONFIG ───────────────── */

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;

/* ───────────────── STATE ───────────────── */

// sessionId -> { a: ws|null, b: ws|null }
const sessions = new Map();

// knockName -> ws
const knocks = new Map();

/* ───────────────── LOGGING (NO BUFFERING) ───────────────── */

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
  ws.knockName = null;
  ws.isAlive = true;

  log("WS_CONNECT", ws.id, req.socket.remoteAddress ?? "");

  /* ───── HEARTBEAT ───── */

  ws.on("pong", () => {
    ws.isAlive = true;
    log("PONG", ws.id);
  });

  /* ───── MESSAGE HANDLING ───── */

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
      /* ───────── PRESENCE / SESSION ───────── */

      case "join": {
        const sessionId = msg.address || msg.linkToken;
        if (!sessionId) {
          log("JOIN_REJECTED", ws.id, "no_session_id");
          return;
        }

        ws.sessionId = sessionId;

        let session = sessions.get(sessionId);
        if (!session) {
          session = { a: ws, b: null };
          sessions.set(sessionId, session);
          log("SESSION_CREATED", sessionId, "A=", ws.id);
          return;
        }

        if (!session.b) {
          session.b = ws;
          log("SESSION_READY", sessionId, "A=", session.a?.id, "B=", ws.id);
          safeSend(session.a, { type: "ready" });
          safeSend(session.b, { type: "ready" });
        } else {
          log("SESSION_FULL", sessionId);
        }
        break;
      }

      case "ping":
        log("PING", ws.id);
        safeSend(ws, { type: "pong" });
        break;

      /* ───────── RELAY MESSAGES ───────── */

      case "text":
      case "hold":
      case "clear":
      case "reveal_frame": {
        const peer = getPeer(ws);
        if (!peer) {
          log("RELAY_FAIL_NO_PEER", ws.id);
          return;
        }
        log("RELAY", msg.type, ws.id, "→", peer.id);
        safeSend(peer, msg);
        break;
      }

      /* ───────── COLLAPSE ───────── */

      case "collapse": {
        log("COLLAPSE", ws.id, msg.reason ?? "");
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

      /* ───────── KNOCK SYSTEM ───────── */

      case "register_knock":
        ws.knockName = msg.name;
        knocks.set(msg.name, ws);
        log("KNOCK_REGISTER", msg.name, ws.id);
        break;

      case "knock_response": {
        const target = knocks.get(msg.id);
        if (target) {
          log("KNOCK_RESPONSE", msg.id, ws.id);
          safeSend(target, msg);
        } else {
          log("KNOCK_RESPONSE_FAIL", msg.id);
        }
        break;
      }

      default:
        log("UNKNOWN_TYPE", ws.id, msg.type);
    }
  });

  /* ───── CLOSE ───── */

  ws.on("close", () => {
    log("WS_CLOSE", ws.id, ws.sessionId ?? "");
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

/* ───────────────── UTILITIES ───────────────── */

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
      if (!s.a && !s.b) {
        sessions.delete(ws.sessionId);
        log("SESSION_REMOVED", ws.sessionId);
      }
    }
  }

  if (ws.knockName) {
    knocks.delete(ws.knockName);
    log("KNOCK_REMOVED", ws.knockName);
  }
}

/* ───────────────── SERVER HEARTBEAT ───────────────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log("TERMINATE", ws.id);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
    log("PING_OUT", ws.id);
  });
}, HEARTBEAT_INTERVAL);

/* ───────────────── START ───────────────── */

server.listen(PORT, () => {
  log("SERVER_STARTED", PORT);
});
