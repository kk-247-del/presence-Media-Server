/**
 * Presence Media / Signaling Server (Authoritative Registry)
 * Features: Identity, TTL Expiry, Dashboard Management, and One-Time Use Logic.
 */

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;
const HEARTBEAT_INTERVAL = 20000;

/**
 * addressRegistry: addressId -> { 
 * addressId, creatorId, nickname, keepAliveOnFailure, expiresAt, status 
 * }
 */
const addressRegistry = new Map();

/**
 * sessions: addressId -> { a: WebSocket, b: WebSocket, obstructionTimer }
 */
const sessions = new Map();

/* ───────────────── UTILS ───────────────── */

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function uid() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // Short 6-char hex IDs
}

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getPeer(ws) {
  const s = sessions.get(ws.sessionId);
  if (!s) return null;
  return s.a === ws ? s.b : s.a;
}

/* ───────────────── DASHBOARD UPDATES ───────────────── */

/**
 * Sends a list of all addresses owned by a specific socket to that socket.
 */
function sendDashboardUpdate(ws) {
  const userAddresses = Array.from(addressRegistry.values())
    .filter(addr => addr.creatorId === ws.id);
  
  safeSend(ws, { 
    type: "dashboard_update", 
    addresses: userAddresses 
  });
}

/* ───────────────── COLLAPSE LOGIC ───────────────── */

function hardCollapse(ws, reason) {
  const addrId = ws.sessionId;
  const s = sessions.get(addrId);
  if (!s) return;

  log("COLLAPSE", addrId, reason);

  // Clear server-side timers
  if (s.obstructionTimer) clearTimeout(s.obstructionTimer);

  const peer = getPeer(ws);
  if (peer) {
    safeSend(peer, { type: "collapse_hard", reason });
  }

  // Handle Registry Policy
  const entry = addressRegistry.get(addrId);
  if (entry) {
    if (reason === "session_completed_successfully") {
      addressRegistry.delete(addrId); // Burn after successful use
    } else if (!entry.keepAliveOnFailure) {
      addressRegistry.delete(addrId); // Burn because it failed and keepAlive was false
    } else {
      entry.status = 'available'; // Preserve for another attempt
    }
  }

  sessions.delete(addrId);
  sendDashboardUpdate(ws);
  if (peer) sendDashboardUpdate(peer);
}

/* ───────────────── REGISTRY JANITOR ───────────────── */

// Clean up expired addresses once every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of addressRegistry.entries()) {
    if (now > data.expiresAt && data.status !== 'active') {
      addressRegistry.delete(id);
      log("EXPIRED", id);
    }
  }
}, 60000);

/* ───────────────── WEBSOCKET LOGIC ───────────────── */

const server = http.createServer((_, res) => res.end("Presence Server Online"));
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.isAlive = true;
  log("NEW_CONNECTION", ws.id);

  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      /* ── DASHBOARD: RESERVE ── */
      case "reserve_address": {
        const { expiryHours, keepAliveOnFailure, nickname } = msg;
        const addressId = uid(); 
        const expiresAt = Date.now() + (Math.max(1, Math.min(hours, 24)) * 3600000);

        addressRegistry.set(addressId, {
          addressId,
          creatorId: ws.id,
          nickname: nickname || "Anonymous",
          keepAliveOnFailure: !!keepAliveOnFailure,
          expiresAt,
          status: 'available'
        });

        log("RESERVED", addressId, `by ${ws.id}`);
        sendDashboardUpdate(ws);
        break;
      }

      /* ── DASHBOARD: DELETE ── */
      case "delete_address": {
        const entry = addressRegistry.get(msg.addressId);
        if (entry && entry.creatorId === ws.id) {
          // If a session is currently active on this ID, kill it
          if (entry.status === 'active') hardCollapse(ws, "owner_terminated");
          addressRegistry.delete(msg.addressId);
          sendDashboardUpdate(ws);
        }
        break;
      }

      /* ── CORE: JOIN ── */
      case "join": {
        const addrId = msg.address;
        const entry = addressRegistry.get(addrId);

        if (!entry || entry.status === 'consumed' || Date.now() > entry.expiresAt) {
          return safeSend(ws, { type: "error", message: "Invalid or expired address" });
        }

        ws.sessionId = addrId;
        let s = sessions.get(addrId);

        if (!s) {
          entry.status = 'active';
          sessions.set(addrId, { a: ws, b: null });
          log("SESSION_START", addrId);
        } else if (!s.b) {
          s.b = ws;
          safeSend(s.a, { type: "ready", role: "initiator", peerNickname: entry.nickname });
          safeSend(s.b, { type: "ready", role: "polite", peerNickname: entry.nickname });
        }
        break;
      }

      /* ── WEBRTC / SIGNALING ── */
      case "peer_obstructed":
      case "peer_restored":
      case "webrtc_offer":
      case "webrtc_answer":
      case "webrtc_ice": {
        const peer = getPeer(ws);
        if (peer) safeSend(peer, msg);
        break;
      }

      case "collapse_user_intent":
        hardCollapse(ws, "session_completed_successfully");
        break;
    }
  });

  ws.on("close", () => {
    if (ws.sessionId) hardCollapse(ws, "socket_lost");
    log("WS_DISCONNECT", ws.id);
  });
});

/* ───────────────── HEARTBEAT ───────────────── */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, "0.0.0.0", () => log("SERVER_RUNNING", PORT));
