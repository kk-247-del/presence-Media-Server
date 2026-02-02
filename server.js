/**
 * Locus Coordination Server
 * AUTHORITATIVE – deterministic obstruction + collapse
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 30000; // Railway prefers slightly longer intervals
const COLLAPSE_GRACE_SECONDS = 10;

const sessions = new Map();

/* ─── UTILS ─── */
const log = (...args) => console.log(new Date().toISOString(), ...args);
const uid = () => crypto.randomUUID();

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

const getSession = (ws) => ws.sessionId ? sessions.get(ws.sessionId) : null;
const getPeer = (ws) => {
  const s = getSession(ws);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
};

/* ─── OBSTRUCTION LOGIC ─── */
function startObstruction(actor, reason) {
  const s = getSession(actor);
  if (!s || s.obstructionActive) return;

  const peer = getPeer(actor);
  if (!peer) return;

  s.obstructionActive = true;
  log("PEER_OBSTRUCTED", peer.id, reason);

  safeSend(peer, {
    type: "peer_obstructed",
    seconds: COLLAPSE_GRACE_SECONDS,
    reason,
  });

  s.obstructionTimer = setTimeout(() => {
    if (!s.obstructionActive) return;
    hardCollapse(actor, "grace_elapsed");
  }, COLLAPSE_GRACE_SECONDS * 1000);
}

function cancelObstruction(actor) {
  const s = getSession(actor);
  if (!s || !s.obstructionActive) return;

  s.obstructionActive = false;
  if (s.obstructionTimer) {
    clearTimeout(s.obstructionTimer);
    s.obstructionTimer = null;
  }

  const peer = getPeer(actor);
  if (peer) safeSend(peer, { type: "peer_restored" });
}

function hardCollapse(ws, reason) {
  const s = getSession(ws);
  if (!s) return;

  cancelObstruction(ws);
  const peer = getPeer(ws);
  if (peer) safeSend(peer, { type: "presence_update", isPresent: false, reason });

  // Cleanup session references
  if (s.a === ws) s.a = null;
  if (s.b === ws) s.b = null;
  if (!s.a && !s.b) sessions.delete(ws.sessionId);
  
  ws.terminate();
}

/* ─── SERVER ─── */
const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end("Presence signaling server alive");
});

// FIX: Removed 'path: "/ws"' to allow direct ID connection
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  ws.id = uid();
  // Extract ID from URL path (e.g., /KAB123)
  ws.sessionId = req.url.split('/').pop()?.toUpperCase();
  ws.isAlive = true;

  if (!ws.sessionId || ws.sessionId === "" || ws.sessionId === "WS") {
     ws.terminate();
     return;
  }

  log("WS_CONNECT", ws.id, "Session:", ws.sessionId);

  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Locus Heartbeat Protocol
    if (msg.type === 'heartbeat') {
        ws.isAlive = true;
        if (msg.foreground === false) {
            startObstruction(ws, "backgrounded");
        } else {
            cancelObstruction(ws);
        }
        return;
    }

    switch (msg.type) {
      case "join": // Manual join if not using URL params
        // Already handled by URL extraction above, but kept for compatibility
        break;

      case "peer_obstructed":
        startObstruction(ws, msg.reason);
        break;

      case "peer_restored":
        cancelObstruction(ws);
        break;

      default:
        const peer = getPeer(ws);
        if (peer) {
            safeSend(peer, msg);
        } else {
            // First one in the room
            let s = sessions.get(ws.sessionId);
            if (!s) {
                s = { a: ws, b: null, obstructionActive: false, obstructionTimer: null };
                sessions.set(ws.sessionId, s);
            } else if (s.a !== ws && !s.b) {
                s.b = ws;
                safeSend(s.a, { type: "presence_update", isPresent: true, role: "initiator" });
                safeSend(s.b, { type: "presence_update", isPresent: true, role: "polite" });
            }
        }
    }
  });

  ws.on("close", () => hardCollapse(ws, "socket_closed"));
});

/* ─── HEARTBEAT ─── */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log("SERVER_STARTED", PORT));
