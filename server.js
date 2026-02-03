import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

// Railway dynamic port binding
const PORT = process.env.PORT || 8080;

const server = createServer((req, res) => {
    res.writeHead(200);
    res.end("Presence Signal Plane is Active (ESM)\n");
});

const wss = new WebSocketServer({ server });

/**
 * REGISTRY & PERSISTENCE
 * registry: active socket connections
 * mintedStore: every address ever generated (The Memory)
 */
const registry = new Map();
const mintedStore = new Set();

wss.on('connection', (ws, req) => {
    // 1. EXTRACT IDENTITY
    const protocol = req.headers['sec-websocket-protocol'];
    const address = protocol ? protocol.split(',')[0].trim().toUpperCase() : null;

    if (!address) {
        console.log("❌ REJECTED: Connection attempt without Locus ID.");
        ws.terminate();
        return;
    }

    // 2. REGISTER & PERSIST
    registry.set(address, ws);
    mintedStore.add(address); 
    
    console.log(`🌍 [MINTED/ONLINE] Identity: ${address}`);

    // 3. SEND WELCOME SYNC
    ws.send(JSON.stringify({
        type: 'sync_success',
        identity: address,
        timestamp: new Date().toISOString()
    }));

    // 4. MESSAGE ROUTING
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`📩 [${address}] -> ${data.type}`);

            switch (data.type) {
                case 'lookup_address':
                    _handleLookup(ws, data.address);
                    break;

                case 'send_proposal':
                    _relayToTarget(address, data.toAddress, {
                        type: 'incoming_proposal',
                        fromAddress: address,
                        fromName: data.fromName,
                        proposedTime: data.proposedTime
                    });
                    break;

                case 'respond_to_proposal':
                    _relayToTarget(address, data.to, data);
                    break;

                default:
                    _relayToTarget(address, data.to || data.target, data);
                    break;
            }
        } catch (e) {
            console.error("⚠️ Signal Error:", e);
        }
    });

    ws.on('close', () => {
        registry.delete(address);
        console.log(`🌑 [OFFLINE] ${address}`);
    });

    ws.on('error', (err) => {
        console.error(`🚨 Socket Error for ${address}:`, err);
    });
});

/* ── HELPERS ── */

function _handleLookup(ws, targetAddress) {
    if (!targetAddress) return;
    const target = targetAddress.toUpperCase();
    const isMinted = mintedStore.has(target);
    const isOnline = registry.has(target);

    ws.send(JSON.stringify({
        type: 'lookup_response',
        address: target,
        found: isMinted, 
        status: isOnline ? 'online' : 'offline',
        name: isOnline ? "ACTIVE_PEER" : "OFFLINE_PEER"
    }));
}

function _relayToTarget(fromAddress, toAddress, payload) {
    if (!toAddress) return;
    const targetWs = registry.get(toAddress.toUpperCase());

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            ...payload,
            from: fromAddress
        }));
    } else {
        console.log(`📭 Target ${toAddress} is currently offline.`);
    }
}

// Bind to 0.0.0.0 for cloud routing
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Presence Plane Online (ESM) | Port: ${PORT}`);
});
