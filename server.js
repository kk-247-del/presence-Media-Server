import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000;
const sessions = new Map();

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

function hardCollapse(ws, reason) {
  const s = sessions.get(ws.sessionId);
  if (!s) return;
  const peer = getPeer(ws);
  if (peer) safeSend(peer, { type: "presence_update", isPresent: false, reason });
  if (s.a === ws) s.a = null;
  if (s.b === ws) s.b = null;
  if (!s.a && !s.b) sessions.delete(ws.sessionId);
  ws.terminate();
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Locus Coordination Server Active");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  // LAW: Protocol used as Session ID
  ws.sessionId = req.headers['sec-websocket-protocol']?.toUpperCase() || "LOBBY";
  log(`✨ Peer joined Session: ${ws.sessionId}`);

  let s = sessions.get(ws.sessionId);
  if (!s) {
    s = { a: ws, b: null };
    sessions.set(ws.sessionId, s);
  } else if (!s.b) {
    s.b = ws;
    // Notify both that the bridge is alive
    safeSend(s.a, { type: "presence_update", isPresent: true, role: "initiator" });
    safeSend(s.b, { type: "presence_update", isPresent: true, role: "polite" });
  }

  ws.on("pong", () => ws.isAlive = true);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'heartbeat') {
      ws.isAlive = true;
      if (msg.foreground === false) hardCollapse(ws, "backgrounded");
      return;
    }
    const peer = getPeer(ws);
    if (peer) safeSend(peer, msg); // Forwards WebRTC SDP/ICE
  });

  ws.on("close", () => hardCollapse(ws, "socket_closed"));
  ws.on("error", () => hardCollapse(ws, "socket_error"));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log(`🚀 Server on port ${PORT}`));
