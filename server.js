import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 8080;
const server = createServer((req, res) => {
    res.writeHead(200);
    res.end("Presence Validated Signal Plane Active\n");
});

const wss = new WebSocketServer({ server });
const registry = new Map(); // Active Sockets
const mintedStore = new Map(); // Persistent Memory { ID: { name, mintedAt } }

wss.on('connection', (ws, req) => {
    const protocol = req.headers['sec-websocket-protocol'];
    const address = protocol ? protocol.split(',')[0].trim().toUpperCase() : null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'register_identity':
                    // VALIDATION: Must have 6-char ID and a real Nickname
                    if (data.address.length === 6 && data.name && data.name !== "GUEST") {
                        registry.set(data.address, ws);
                        mintedStore.set(data.address, {
                            name: data.name,
                            mintedAt: new Date()
                        });
                        console.log(`💎 [VALIDATED MINT] ${data.address} is ${data.name}`);
                    }
                    break;

                case 'lookup_address':
                    const target = data.address.toUpperCase();
                    const identity = mintedStore.get(target);
                    
                    ws.send(JSON.stringify({
                        type: 'lookup_response',
                        address: target,
                        found: !!identity,
                        name: identity ? identity.name : null,
                        status: registry.has(target) ? 'online' : 'offline'
                    }));
                    break;

                case 'send_proposal':
                    _relay(data.fromAddress, data.toAddress, {
                        type: 'incoming_proposal',
                        fromAddress: data.fromAddress,
                        fromName: data.fromName,
                        proposedTime: data.proposedTime
                    });
                    break;

                default:
                    _relay(data.from, data.to || data.target, data);
                    break;
            }
        } catch (e) { console.error("Signal Error:", e); }
    });

    ws.on('close', () => {
        // Remove from active registry, but keep in mintedStore (The Memory)
        if (address) registry.delete(address);
    });
});

function _relay(from, to, payload) {
    if (!to) return;
    const targetWs = registry.get(to.toUpperCase());
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ ...payload, from }));
    }
}

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Plane Live on ${PORT}`));
