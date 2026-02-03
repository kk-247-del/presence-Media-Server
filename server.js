const { WebSocketServer } = require('ws');
const http = require('http');

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Signaling Server is running');
});

const wss = new WebSocketServer({ server });

// Map to track peers in rooms: { "roomID": [socket1, socket2] }
const rooms = new Map();

wss.on('connection', (ws, req) => {
  // Your Dart code sends the 'address' via the protocol header
  const roomId = ws.protocol;

  if (!roomId) {
    console.log("Connection rejected: No address (protocol) provided.");
    ws.close(1002, "Protocol required");
    return;
  }

  // Initialize room if it doesn't exist
  if (!rooms.has(roomId)) {
    rooms.set(roomId, []);
  }

  const clients = rooms.get(roomId);

  if (clients.length >= 2) {
    console.log(`Room ${roomId} is full.`);
    ws.close(1013, "Room Full");
    return;
  }

  // Add client to room
  clients.push(ws);
  console.log(`User joined room: ${roomId}. Total: ${clients.length}`);

  // If this is the second user, notify both to start WebRTC
  if (clients.length === 2) {
    const [peer1, peer2] = clients;
    
    // Peer 1 was there first (Initiator)
    peer1.send(JSON.stringify({ type: 'presence_update', isPresent: true, role: 'initiator' }));
    // Peer 2 just joined (Polite)
    peer2.send(JSON.stringify({ type: 'presence_update', isPresent: true, role: 'polite' }));
  }

  ws.on('message', (data) => {
    // Relay message to the OTHER person in the room
    const message = data.toString();
    const otherPeer = clients.find(client => client !== ws);
    
    if (otherPeer && otherPeer.readyState === 1) {
      otherPeer.send(message);
    }
  });

  ws.on('close', () => {
    const index = clients.indexOf(ws);
    if (index > -1) {
      clients.splice(index, 1);
    }
    
    // Notify remaining peer that the other left
    if (clients.length === 1) {
      clients[0].send(JSON.stringify({ type: 'presence_update', isPresent: false }));
    } else {
      rooms.delete(roomId);
    }
    console.log(`User left room: ${roomId}`);
  });
});

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
