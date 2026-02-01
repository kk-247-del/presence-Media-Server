 import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Presence Media Server Active");
});

const wss = new WebSocketServer({ server });

// In-memory registry
let registry = [];

wss.on('connection', (ws) => {
  console.log('📦 Peer Connected');

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData);

      switch (msg.type) {
        case 'handshake':
        case 'get_dashboard':
          sendDashboardUpdate(ws);
          break;

        case 'reserve_address':
          const newId = uuidv4().substring(0, 8).toUpperCase();
          const entry = {
            id: newId,
            address: newId,
            nickname: msg.nickname || 'Anonymous',
            expiry: `${msg.expiryHours || 24}h`,
            expiresAt: Date.now() + (msg.expiryHours || 24) * 3600000
          };
          registry.push(entry);
          broadcastDashboard();
          break;

        case 'delete_address':
          registry = registry.filter(item => item.id !== msg.addressId);
          broadcastDashboard();
          break;

        case 'join':
          // Identify this socket with the address they are "Arming"
          ws.presenceAddress = msg.address;
          
          // Find if there is someone else already at this address
          const peers = Array.from(wss.clients).filter(
            client => client !== ws && client.presenceAddress === msg.address
          );

          if (peers.length > 0) {
            // Pair found!
            const peer = peers[0];
            ws.send(JSON.stringify({ type: 'ready', role: 'joiner' }));
            peer.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
          } else {
            // Wait for a peer...
            console.log(`Waiting for peer on: ${msg.address}`);
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        // 🛰️ WebRTC Signaling Relay
        // Forwards offer/answer/ice to the other person on the same address
        case 'webrtc_offer':
        case 'webrtc_answer':
        case 'webrtc_ice':
        case 'text':
        case 'reveal_frame':
          relayToPeer(ws, msg);
          break;
      }
    } catch (e) {
      console.error("Signal Error:", e);
    }
  });

  ws.on('close', () => console.log('🔌 Peer Disconnected'));
});

/**
 * RELAY LOGIC: Finds the other person at the same address and sends them the data
 */
function relayToPeer(sender, msg) {
  wss.clients.forEach(client => {
    if (client !== sender && 
        client.readyState === WebSocket.OPEN && 
        client.presenceAddress === sender.presenceAddress) {
      client.send(JSON.stringify(msg));
    }
  });
}

function sendDashboardUpdate(ws) {
  ws.send(JSON.stringify({ type: 'dashboard_update', addresses: registry }));
}

function broadcastDashboard() {
  const data = JSON.stringify({ type: 'dashboard_update', addresses: registry });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// 🧹 Clean expired addresses every 5 minutes
setInterval(() => {
  const now = Date.now();
  const initialLength = registry.length;
  registry = registry.filter(item => item.expiresAt > now);
  if (registry.length !== initialLength) broadcastDashboard();
}, 300000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
