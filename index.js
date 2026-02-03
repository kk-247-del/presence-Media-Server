const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

/**
 * GLOBAL REGISTRY
 * Maps address IDs to Presence Objects:
 * { id, nickname, duration, expiresAt, isPersistent, socket? }
 */
let registry = new Map();

console.log("PRESENCE SIGNAL SERVER STARTING...");

wss.on('connection', (ws, req) => {
    // The protocol header contains the requested Address ID
    const addressId = req.headers['sec-websocket-protocol'];
    
    if (!addressId) {
        console.log("REJECTED: No Address ID provided.");
        ws.close();
        return;
    }

    console.log(`SESSION REQUEST: ${addressId}`);

    // 1. HANDLE MESSAGES
    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        switch (msg.type) {
            case 'reserve_request':
                handleReserve(msg);
                break;

            case 'delete_request':
                handleDelete(msg.id);
                break;

            case 'identity_broadcast':
                handleBroadcast(addressId, msg);
                break;

            case 'webrtc_offer':
            case 'webrtc_answer':
            case 'webrtc_ice':
                relaySignal(addressId, msg);
                break;
        }
    });

    // 2. JOIN LOGIC
    // Link the active socket to the registry entry
    let entry = registry.get(addressId);
    if (!entry) {
        // Create an ephemeral entry if it doesn't exist (Guest Login)
        entry = { id: addressId, nickname: "GUEST", isPersistent: false };
        registry.set(addressId, entry);
    }
    
    entry.socket = ws;

    // 3. HANDSHAKE (Determine Roles)
    const peers = Array.from(wss.clients).filter(c => 
        c !== ws && c.protocol === addressId && c.readyState === WebSocket.OPEN
    );

    if (peers.length > 0) {
        console.log(`PEER MATCH: ${addressId}`);
        // Send 'ready' to both sides with roles
        ws.send(json({ type: 'ready', role: 'initiator' }));
        peers[0].send(json({ type: 'ready', role: 'polite' }));
    }

    // 4. DISCONNECT LOGIC
    ws.on('close', () => {
        const currentEntry = registry.get(addressId);
        if (currentEntry && !currentEntry.isPersistent) {
            // Only delete from registry if it wasn't a "Minted" address
            registry.delete(addressId);
            broadcastRegistry();
        } else if (currentEntry) {
            // Keep reserved address, but mark as offline
            currentEntry.socket = null;
        }
    });
});

// --- ENGINE LOGIC ---

function handleReserve(data) {
    const expiresAt = Date.now() + (data.hours * 3600000);
    registry.set(data.address, {
        id: data.address,
        nickname: data.nickname,
        duration: data.hours,
        expiresAt: expiresAt,
        isPersistent: true,
        socket: null
    });
    console.log(`MINTED: ${data.address} for ${data.nickname}`);
    broadcastRegistry();
}

function handleDelete(id) {
    registry.delete(id);
    console.log(`PURGED: ${id}`);
    broadcastRegistry();
}

function handleBroadcast(id, msg) {
    const entry = registry.get(id);
    if (entry) entry.nickname = msg.nickname;
    broadcastRegistry();
}

function relaySignal(addressId, msg) {
    // Relay WebRTC data to the other socket in the same "room"
    wss.clients.forEach(client => {
        if (client.protocol === addressId && client.readyState === WebSocket.OPEN && client !== registry.get(addressId).socket) {
            client.send(JSON.stringify(msg));
        }
    });
}

function broadcastRegistry() {
    const data = JSON.stringify({
        type: 'registry_update',
        addresses: Array.from(registry.values()).map(e => ({
            id: e.id,
            nickname: e.nickname,
            remainingTime: e.isPersistent ? formatTTL(e.expiresAt) : "EPHEMERAL"
        }))
    });
    wss.clients.forEach(client => client.send(data));
}

// --- UTILS ---

function formatTTL(expiry) {
    const diff = expiry - Date.now();
    if (diff <= 0) return "EXPIRED";
    const hours = Math.floor(diff / 3600000);
    return hours === 0 ? "SINGLE USE" : `${hours}H LEFT`;
}

function json(obj) { return JSON.stringify(obj); }

// Cleanup expired addresses every 5 minutes
setInterval(() => {
    const now = Date.now();
    registry.forEach((v, k) => {
        if (v.isPersistent && v.expiresAt < now) {
            registry.delete(k);
        }
    });
    broadcastRegistry();
}, 300000);
