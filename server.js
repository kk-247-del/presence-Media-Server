import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000;

// Memory stores
const sessions = new Map(); // sessionId → { a: WebSocket, b: WebSocket }
const registry = new Map(); // address → { name, socket }

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
  if (peer) {
    log(`[${ws.sessionId}] Terminating peer: ${reason}`);
    safeSend(peer, { type: "presence_update", isPresent: false, reason });
    peer.terminate();
  }
  sessions.delete(ws.sessionId);
  registry.delete(ws.sessionId);
  ws.terminate();
  log(`[${ws.sessionId}] Room collapsed.`);
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Locus Control Plane: Harmonized");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  // Use sub-protocol header as the Address (Contract: HAC295)
  ws.sessionId = req.headers['sec-websocket-protocol']?.toUpperCase() || "LOBBY";

  // Register user for lookup/knocking
  registry.set(ws.sessionId, { socket: ws, name: "GUEST" });

  let s = sessions.get(ws.sessionId);
  if (!s) {
    s = { a: ws, b: null };
    sessions.set(ws.sessionId, s);
    log(`[${ws.sessionId}] Locus Active. Waiting for Peer B...`);
  } else if (!s.b) {
    s.b = ws;
    log(`[${ws.sessionId}] Peer B matched. Bridging pathway.`);
    safeSend(s.a, { type: "presence_update", isPresent: true, role: "initiator" });
    safeSend(s.b, { type: "presence_update", isPresent: true, role: "polite" });
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- FEATURE: LOOKUP ---
    if (msg.type === "lookup_address") {
      const target = registry.get(msg.address?.toUpperCase());
      safeSend(ws, { 
        type: "lookup_response", 
        found: !!target, 
        name: target ? target.name : null 
      });
      return;
    }

    // --- FEATURE: KNOCKING ---
    if (msg.type === "send_proposal") {
      const target = registry.get(msg.toAddress?.toUpperCase());
      if (target) {
        safeSend(target.socket, {
          type: "incoming_proposal",
          fromName: msg.fromName,
          fromAddress: msg.fromAddress,
          proposedTime: msg.proposedTime
        });
      }
      return;
    }

    if (msg.type === "heartbeat") {
      ws.isAlive = true;
      if (msg.foreground === false) hardCollapse(ws, "peer_backgrounded");
      return;
    }

    // Official Passthrough for Live Signals (Text, Reveal, SDP)
    const peer = getPeer(ws);
    if (peer) peer.send(raw.toString());
  });

  ws.on("close", () => {
    registry.delete(ws.sessionId);
    hardCollapse(ws, "socket_closed");
  });
  ws.on("pong", () => (ws.isAlive = true));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log(`🚀 Server listening on ${PORT}`));
