import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000;

// Memory stores
const sessions = new Map(); // sessionId → { a: WebSocket, b: WebSocket }
const registry = new Map(); // address → { name, socket } (For finding peers)

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
    log(`[${ws.sessionId}] Terminating peer connection: ${reason}`);
    safeSend(peer, { type: "presence_update", isPresent: false, reason });
    peer.terminate();
  }
  sessions.delete(ws.sessionId);
  registry.delete(ws.sessionId); // Remove from lookup registry
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
  // Your official protocol: The Room ID is the Locus Address
  ws.sessionId = req.headers['sec-websocket-protocol']?.toUpperCase() || "LOBBY";

  // --- REGISTRY LOGIC ---
  // We register the user so others can "Lookup" and "Knock"
  registry.set(ws.sessionId, { socket: ws, name: "GUEST" });

  let s = sessions.get(ws.sessionId);

  if (!s) {
    s = { a: ws, b: null };
    sessions.set(ws.sessionId, s);
    log(`[${ws.sessionId}] Locus Active. Waiting for Peer B...`);
  } else if (!s.b) {
    s.b = ws;
    log(`[${ws.sessionId}] Peer B matched. Launching Moment.`);
    safeSend(s.a, { type: "presence_update", isPresent: true, role: "initiator" });
    safeSend(s.b, { type: "presence_update", isPresent: true, role: "polite" });
  } else {
    ws.close(1000, "ROOM_FULL");
    return;
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- HARMONIZED FEATURE: LOOKUP ---
    if (msg.type === "lookup_address") {
      const target = registry.get(msg.address?.toUpperCase());
      safeSend(ws, { 
        type: "lookup_response", 
        found: !!target, 
        name: target ? target.name : null 
      });
      return;
    }

    // --- HARMONIZED FEATURE: KNOCK (Routing) ---
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

    // Official Passthrough (SDP/ICE/Signals)
    const peer = getPeer(ws);
    if (peer) peer.send(raw.toString());
  });

  ws.on("close", () => {
    registry.delete(ws.sessionId);
    hardCollapse(ws, "socket_closed");
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log(`🚀 Harmonized Server on port ${PORT}`));
