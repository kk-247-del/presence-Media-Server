import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000;

// Memory store for active sessions: sessionId → { a: WebSocket, b: WebSocket }
const sessions = new Map();

const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * Sends a JSON payload safely to a client
 */
function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Retrieves the opposite peer in the session
 */
const getPeer = (ws) => {
  const s = sessions.get(ws.sessionId);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
};

/**
 * Forcefully closes the room and disconnects both peers
 */
function hardCollapse(ws, reason) {
  const s = sessions.get(ws.sessionId);
  if (!s) return;

  const peer = getPeer(ws);
  if (peer) {
    log(`[${ws.sessionId}] Terminating peer connection due to: ${reason}`);
    safeSend(peer, { type: "presence_update", isPresent: false, reason });
    peer.terminate(); // Immediate disconnection of the remaining peer
  }

  sessions.delete(ws.sessionId);
  ws.terminate();
  log(`[${ws.sessionId}] Room collapsed.`);
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Locus Signaling Server: Active");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  
  // Use the WebSocket sub-protocol as the unique Room/Session ID
  ws.sessionId = req.headers['sec-websocket-protocol']?.toUpperCase() || "LOBBY";

  let s = sessions.get(ws.sessionId);

  if (!s) {
    // ── PEER A: THE OFFERER / ROOM OWNER ──
    s = { a: ws, b: null };
    sessions.set(ws.sessionId, s);
    log(`[${ws.sessionId}] Room created. Peer A (Offerer) waiting...`);
  } else if (!s.b) {
    // ── PEER B: THE JOINER / POLITE PEER ──
    s.b = ws;
    log(`[${ws.sessionId}] Peer B joined. Bridging signaling pathway.`);

    // Signal both peers to launch their MomentSurface.
    // Peer A is assigned 'initiator' to start the WebRTC Offer.
    safeSend(s.a, { type: "presence_update", isPresent: true, role: "initiator" });
    safeSend(s.b, { type: "presence_update", isPresent: true, role: "polite" });
  } else {
    // ── REJECT: ROOM FULL ──
    log(`[${ws.sessionId}] Rejecting 3rd peer: Room full.`);
    ws.close(1000, "ROOM_FULL");
    return;
  }

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle Heartbeats
    if (msg.type === "heartbeat") {
      ws.isAlive = true;
      if (msg.foreground === false) hardCollapse(ws, "peer_backgrounded");
      return;
    }

    // Direct Passthrough: Forward SDP/ICE/Text signals to the other peer
    const peer = getPeer(ws);
    if (peer) {
      peer.send(raw.toString());
    }
  });

  ws.on("close", () => hardCollapse(ws, "socket_closed"));
  ws.on("error", () => hardCollapse(ws, "socket_error"));
});

// Railway/Heroku Keep-Alive & Dead Connection Cleanup
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log(`🚀 Signaling Server on port ${PORT}`));
