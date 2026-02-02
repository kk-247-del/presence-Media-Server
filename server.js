import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 8080;

// LAW: Minimal Coordination Backend. No Storage.
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Locus Class Coordination Active");
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Extract the Window ID from the URL: wss://domain.com/v1/KAB123
  const driftWindowId = req.url.split('/').pop()?.toUpperCase();

  if (!driftWindowId || driftWindowId.length < 3) {
    ws.close(1008, "Invalid Drift Window");
    return;
  }

  ws.driftId = driftWindowId;
  ws.isAlive = true;

  console.log(`📡 Window ${driftWindowId}: Peer Entered`);

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData);

      switch (msg.type) {
        // LAW #1: Presence Heartbeats. Continually evaluated.
        case 'heartbeat':
          ws.isAlive = true;
          ws.foreground = msg.foreground;
          evaluatePresence(driftWindowId);
          break;

        // LAW #2: No "Send". These are real-time expressions being relayed.
        case 'text':
        case 'hold':
        case 'clear':
        case 'webrtc_offer':
        case 'webrtc_answer':
        case 'webrtc_ice':
        case 'reveal_frame':
        case 'obstruction':
        case 'restored':
          relayToPeer(ws, msg);
          break;
      }
    } catch (e) {
      console.error("Signal Logic Error:", e);
    }
  });

  ws.on('close', () => {
    console.log(`🔌 Window ${driftWindowId}: Peer Left`);
    notifyCollapse(driftWindowId);
  });
});

/**
 * LAW #1 & #5: Evaluates if both participants are foregrounded.
 * If conditions fail, it triggers a presence_update to collapse the moment.
 */
function evaluatePresence(windowId) {
  const peers = Array.from(wss.clients).filter(c => c.driftId === windowId);
  
  const presenceUpdate = JSON.stringify({
    type: 'presence_update',
    isPresent: peers.length >= 2 && peers.every(p => p.foreground === true)
  });

  peers.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(presenceUpdate);
    }
  });
}

/**
 * RELAY LOGIC: Stateless forwarding.
 */
function relayToPeer(sender, msg) {
  wss.clients.forEach(client => {
    if (client !== sender && 
        client.readyState === WebSocket.OPEN && 
        client.driftId === sender.driftId) {
      client.send(JSON.stringify(msg));
    }
  });
}

function notifyCollapse(windowId) {
  const data = JSON.stringify({ type: 'presence_update', isPresent: false });
  wss.clients.forEach(client => {
    if (client.driftId === windowId && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// 🛡️ LAW #5: Dead-Man Switch
// Every 5 seconds, ensure peers are actually there.
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; // Reset, waiting for next heartbeat
  });
}, 5000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Locus Server listening on port ${PORT}`);
});
