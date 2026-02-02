const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

/**
 * GLOBAL REGISTRY
 * Maps Locus ID (e.g., "HAC295") -> WebSocket Instance
 */
const registry = new Map();

/**
 * PERSISTENT STORE (In-Memory for this example)
 * In production, replace this with a MongoDB/PostgreSQL query.
 */
const mintedAddresses = new Set(["GER988", "PEL221"]); // Pre-seeded examples

wss.on('connection', (ws, req) => {
    // Extract Locus ID from the WebSocket Protocol header
    const address = req.headers['sec-websocket-protocol']?.toUpperCase();

    if (!address) {
        console.log("❌ Rejected: No Locus Identity provided.");
        ws.close();
        return;
    }

    // Register the session
    registry.set(address, ws);
    mintedAddresses.add(address); // Remember this address permanently
    console.log(`🌍 [REGISTERED] ${address} is now online.`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`📩 [SIGNAL] from ${address}:`, data.type);

            switch (data.type) {
                case 'lookup_address':
                    _handleLookup(ws, data.address);
                    break;

                case 'send_proposal':
                    _handleProposal(address, data);
                    break;

                case 'respond_to_proposal':
                    _handleResponse(address, data);
                    break;

                default:
                    // Broadcast live signals (Text, Reveal, WebRTC) to the target peer
                    _relaySignal(address, data);
                    break;
            }
        } catch (e) {
            console.error("⚠️ Message Error:", e);
        }
    });

    ws.on('close', () => {
        registry.delete(address);
        console.log(`🌑 [OFFLINE] ${address} disconnected.`);
    });
});

/* ── HELPER LOGIC ── */

function _handleLookup(ws, targetAddress) {
    const isOnline = registry.has(targetAddress);
    const isMinted = mintedAddresses.has(targetAddress);

    ws.send(JSON.stringify({
        type: 'lookup_response',
        address: targetAddress,
        found: isMinted, // True if the address exists in our memory
        status: isOnline ? 'online' : 'offline',
        name: isOnline ? "ACTIVE_PEER" : "REMEMBERED_ENTITY"
    }));
}

function _handleProposal(fromAddress, data) {
    const targetWs = registry.get(data.toAddress.toUpperCase());
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'incoming_proposal',
            id: `KNK-${Date.now()}`,
            fromAddress: fromAddress,
            fromName: data.fromName || "GUEST",
            proposedTime: data.proposedTime
        }));
        console.log(`✨ [KNOCK] Forwarded from ${fromAddress} to ${data.toAddress}`);
    } else {
        console.log(`📭 [MISSED] ${data.toAddress} is offline. Proposal logged.`);
        // Here you would typically save to a 'PendingProposals' DB table
    }
}

function _handleResponse(fromAddress, data) {
    // Relays accept/decline back to the proposer
    _relaySignal(fromAddress, data);
}

function _relaySignal(senderAddress, data) {
    // This logic assumes the 'data' packet contains a 'to' or 'target' field
    const targetId = data.toAddress || data.target || data.to;
    if (!targetId) return;

    const targetWs = registry.get(targetId.toUpperCase());
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            ...data,
            from: senderAddress
        }));
    }
}

server.listen(PORT, () => {
    console.log(`🚀 Presence Signal Plane active on port ${PORT}`);
});
