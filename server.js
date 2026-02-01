import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

/**
 * 1. SERVER SETUP
 * Railway assigns a dynamic port via process.env.PORT.
 */
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Presence Media Server is Running");
});

const wss = new WebSocketServer({ server });

/**
 * 2. REGISTRY STATE
 */
let registry = [];

wss.on('connection', (ws) => {
  console.log('📦 New Peer Connected');

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData);
      console.log(`📩 Signal Received: ${msg.type}`);

      switch (msg.type) {
        case 'handshake':
        case 'get_dashboard':
          sendDashboardUpdate(ws);
          break;

        case 'reserve_address':
          const newId = uuidv4().substring(0, 8).toUpperCase();
          const newEntry = {
            id: newId,
            address: newId,
            nickname: msg.nickname || 'Anonymous',
            expiry: `${msg.expiryHours || 24}h`,
            createdAt: Date.now()
          };
          registry.push(newEntry);
          console.log(`✨ Reserved Address: ${newId}`);
          broadcastDashboard();
          break;

        case 'delete_address':
          registry = registry.filter(item => item.id !== msg.addressId);
          console.log(`🗑️ Deleted Address: ${msg.addressId}`);
          broadcastDashboard();
          break;

        case 'join':
          const target = registry.find(r => r.address === msg.address);
          if (target) {
            ws.send(JSON.stringify({
              type: 'ready',
              role: 'initiator',
              peerNickname: target.nickname
            }));
          } else {
            ws.send(JSON.stringify({ type: 'collapse', reason: 'address_not_found' }));
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          broadcastToOthers(ws, msg);
          break;
      }
    } catch (e) {
      console.error("❌ Failed to parse message:", e);
    }
  });

  ws.on('close', () => console.log('🔌 Peer Disconnected'));
});

/**
 * 3. HELPER FUNCTIONS
 */

function sendDashboardUpdate(ws) {
  ws.send(JSON.stringify({
    type: 'dashboard_update',
    addresses: registry
  }));
}

function broadcastDashboard() {
  const payload = JSON.stringify({
    type: 'dashboard_update',
    addresses: registry
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcastToOthers(sender, msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
