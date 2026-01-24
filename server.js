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

const uid = () => crypto.randomUUID();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/* ───────────────── HTTP ───────────────── */

const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end("Presence server alive");
});

/* ───────────────── WEBSOCKET ───────────────── */

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.id = uid();
  ws.sessionId = null;
  ws.knockName = null;
  ws.isAlive = true;

  log('[WS CONNECT]', ws.id);

  ws.on("pong", () => {
    ws.isAlive = true;
    log('[PONG]', ws.id);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('[BAD JSON]', ws.id);
      return;
    }

    log('[MSG]', ws.id, msg.type);

    switch (msg.type) {
      case "join": {
        const sessionId = msg.address || msg.linkToken;
        if (!sessionId) return;

        ws.sessionId = sessionId;

        let s = sessions.get(sessionId);
        if (!s) {
          s = { a: ws, b: null };
          sessions.set(sessionId, s);
          log('[SESSION CREATED]', sessionId);
          return;
        }

        if (!s.b) {
          s.b = ws;
          log('[SESSION READY]', sessionId);
          safeSend(s.a, { type: "ready" });
          safeSend(s.b, { type: "ready" });
        }
        break;
      }

      case "ping":
        log('[PING]', ws.id);
        safeSend(ws, { type: "pong" });
        break;

      case "text":
      case "hold":
      case "clear":
      case "reveal_frame": {
        const peer = getPeer(ws);
        if (peer) {
          log('[RELAY]', msg.type, ws.id, '→', peer.id);
          safeSend(peer, msg);
        }
        break;
      }

      case "collapse": {
        log('[COLLAPSE]', ws.id);
        const peer = getPeer(ws);
        if (peer) safeSend(peer, { type: "collapse", reason: msg.reason });
        cleanup(ws);
        break;
      }

      case "register_knock":
        ws.knockName = msg.name;
        knocks.set(msg.name, ws);
        log('[KNOCK REGISTER]', msg.name);
        break;

      case "knock_response": {
        const target = knocks.get(msg.id);
        if (target) {
          log('[KNOCK RESPONSE]', msg.id);
          safeSend(target, msg);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    log('[WS CLOSE]', ws.id, ws.sessionId);
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
      if (!s.a && !s.b) {
        sessions.delete(ws.sessionId);
        log('[SESSION REMOVED]', ws.sessionId);
      }
    }
  }
  if (ws.knockName) knocks.delete(ws.knockName);
}

/* ───────────────── HEARTBEAT ───────────────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log('[TERMINATE]', ws.id);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
    log('[PING OUT]', ws.id);
  });
}, HEARTBEAT_INTERVAL);

/* ───────────────── START ───────────────── */

server.listen(PORT, () => {
  log('SERVER STARTED', PORT);
});
