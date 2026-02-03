import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000;
const COLLAPSE_GRACE_SECONDS = 10;

// sessionId → { a: WebSocket, b: WebSocket, timer: Timeout | null }
const sessions = new Map();
let registry = []; // For the Presence/Dashboard screens

const log = (...args) => console.log(new Date().toISOString(), ...args);

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

const getPeer = (ws) => {
  const s = sessions.get(ws.sessionId);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
};

function broadcastDashboard() {
  const msg = JSON.stringify({ type: 'dashboard_sync', list: registry });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function hardCollapse(ws, reason) {
  const s = sessions.get(ws.sessionId);
  if (!s) return;

  const peer = getPeer(ws);
  if (peer) safeSend(peer, { type: "collapse", reason });

  if (s.a === ws) s.a = null;
  if (s.b === ws) s.b = null;
  if (!s.a && !s.b) sessions.delete(ws.sessionId);
  
  ws.terminate();
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Presence Registry Active");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.sessionId = null;

  log("✨ New Connection Established");

  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'register':
        // Handshake to get initial dashboard
        ws.send(JSON.stringify({ type: 'dashboard_sync', list: registry }));
        break;

      case 'reserve':
        const newAddress = {
          id: msg.id || crypto.randomBytes(3).toString('hex').toUpperCase(),
          nickname: msg.nickname,
          expiresAt: Date.now() + (msg.duration * 3600000)
        };
        registry.push(newAddress);
        broadcastDashboard();
        break;

      case 'join':
        ws.sessionId = msg.address;
        let s = sessions.get(ws.sessionId);
        if (!s) {
          s = { a: ws, b: null };
          sessions.set(ws.sessionId, s);
        } else if (!s.b) {
          s.b = ws;
          safeSend(s.a, { type: "ready", role: "initiator" });
          safeSend(s.b, { type: "ready", role: "polite" });
        }
        break;

      default:
        const peer = getPeer(ws);
        if (peer) safeSend(peer, msg);
        break;
    }
  });

  ws.on("close", () => {
    if (ws.sessionId) hardCollapse(ws, "socket_closed");
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log(`🚀 Server listening on ${PORT}`));
