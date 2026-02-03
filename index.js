const { WebSocketServer } = require('ws');
const http = require('http');

const port = process.env.PORT || 8080;

// Simple HTTP server to satisfy Railway's health checks
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Signaling Server is Live');
});

const wss = new WebSocketServer({ server });

// Room storage: Map<RoomID, WebSocket[]>
const rooms = new Map();

wss.on('connection', (ws, req) => {
    // The Flutter app sends the Address/ID via the protocol header
    const roomId = ws.protocol;

    if (!roomId) {
        console.log("Connection rejected: No Address protocol provided.");
        ws.close(1002, "Protocol Required");
        return;
    }

    // Initialize room
    if (!rooms.has(roomId)) {
        rooms.set(roomId, []);
    }

    const clients = rooms.get(roomId);

    if (clients.length >= 2) {
        console.log(`Room ${roomId} is full.`);
        ws.close(1013, "Room Full");
        return;
    }

    // Assign a default nickname to prevent nulls in Flutter
    ws.nickname = "Anonymous";
    clients.push(ws);

    console.log(`User joined room [${roomId}]. Total users: ${clients.length}`);

    // If room is now full, start the signaling process
    if (clients.length === 2) {
        const [peer1, peer2] = clients;

        // Notify Peer 1 (The Initiator)
        peer1.send(JSON.stringify({
            type: 'presence_update',
            isPresent: true,
            role: 'initiator',
            nickname: peer2.nickname // Guaranteed non-null
        }));

        // Notify Peer 2 (The Polite/Receiver)
        peer2.send(JSON.stringify({
            type: 'presence_update',
            isPresent: true,
            role: 'polite',
            nickname: peer1.nickname // Guaranteed non-null
        }));
    }

    ws.on('message', (rawData) => {
        try {
            const msg = JSON.parse(rawData.toString());

            // Update nickname cache if sent
            if (msg.type === 'identity_broadcast' && msg.nickname) {
                ws.nickname = String(msg.nickname);
            }

            // Relay logic
            const otherPeer = clients.find(client => client !== ws);
            if (otherPeer && otherPeer.readyState === 1) {
                // Attach sender's nickname to every relayed message to prevent Dart Null errors
                msg.nickname = ws.nickname;
                otherPeer.send(JSON.stringify(msg));
            }
        } catch (e) {
            console.error("Error processing message:", e.message);
        }
    });

    ws.on('close', () => {
        const index = clients.indexOf(ws);
        if (index > -1) {
            clients.splice(index, 1);
        }

        // Notify remaining user that the peer left
        if (clients.length === 1) {
            clients[0].send(JSON.stringify({
                type: 'presence_update',
                isPresent: false,
                role: 'none',
                nickname: 'Disconnected'
            }));
        } else {
            rooms.delete(roomId);
        }
        console.log(`User left room [${roomId}]`);
    });
});

server.listen(port, () => {
    console.log(`Signaling server running on port ${port}`);
});
