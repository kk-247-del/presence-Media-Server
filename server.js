import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000;
const sessions = new Map(); // sessionId → { a: WebSocket, b: WebSocket }

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
  // Sub-protocol acts as the Session ID
  ws.sessionId = req.headers['sec-websocket-protocol']?.toUpperCase() || "LOBBY";

  log(`✨ Connection attempt for Room: ${ws.sessionId}`);

  let s = sessions.get(ws.sessionId);
  if (!s) {
    // Peer A joins - Wait for Peer B
    s = { a: ws, b: null };
    sessions.set(ws.sessionId, s);
    log(`👤 Peer A joined ${ws.sessionId}. Standing by...`);
  } else if (!s.b) {
    // Peer B joins - Bridge the connection
    s.b = ws;
    log(`👥 Peer B joined ${ws.sessionId}. Bridging session.`);
    
    // CRITICAL: Only now do we signal 'isPresent: true' to trigger MomentSurface
    safeSend(s.a, { type: "presence_update", isPresent: true, role: "initiator" });
    safeSend(s.b, { type: "presence_update", isPresent: true, role: "polite" });
  } else {
    // Room full
    ws.close(1000, "ROOM_FULL");
    return;
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

    // Forward SDP/ICE/Text signals to the other peer
    const peer = getPeer(ws);
    if (peer) safeSend(peer, msg);
  });

  ws.on("close", () => hardCollapse(ws, "socket_closed"));
  ws.on("error", () => hardCollapse(ws, "socket_error"));
});

// Railway/Cloud Keep-Alive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log(`🚀 Server live on port ${PORT}`));
