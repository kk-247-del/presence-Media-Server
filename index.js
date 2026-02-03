const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
let registry = new Map();

// 1. Create a standard HTTP server to handle both the Dashboard and the WebSocket upgrade
const server = http.createServer((req, res) => {
    if (req.url === '/status') {
        // Serve a JSON snapshot of the internal state
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const status = {
            totalConnections: wss.clients.size,
            activeRooms: Array.from(registry.keys()),
            registry: Array.from(registry.values()).map(e => ({
                ...e,
                socket: e.socket ? 'CONNECTED' : 'OFFLINE'
            }))
        };
        return res.end(JSON.stringify(status, null, 2));
    }

    // Simple HTML Dashboard
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Presence Orbit | Dashboard</title>
            <style>
                body { background: #0f0f0f; color: #00ffaa; font-family: monospace; padding: 40px; }
                .card { border: 1px solid #333; padding: 20px; margin-bottom: 10px; border-radius: 8px; }
                .live { color: #ff3366; animation: blink 1s infinite; }
                @keyframes blink { 50% { opacity: 0; } }
            </style>
        </head>
        <body>
            <h1>PRESENCE <span class="live">●</span> SIGNAL_CORE</h1>
            <div id="stats">Loading telemetry...</div>
            <script>
                async function update() {
                    const res = await fetch('/status');
                    const data = await res.json();
                    document.getElementById('stats').innerHTML = 
                        '<div class="card">ACTIVE_SOCKETS: ' + data.totalConnections + '</div>' +
                        data.registry.map(r => '<div class="card">' + r.id + ' | ' + r.nickname + ' [' + r.socket + ']</div>').join('');
                }
                setInterval(update, 2000); update();
            </script>
        </body>
        </html>
    `);
});

// 2. Attach the WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });



wss.on('connection', (ws, req) => {
    const addressId = req.headers['sec-websocket-protocol'];
    if (!addressId) return ws.close();

    console.log(`SESSION: ${addressId}`);

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            
            // Handle specific logic types
            if (msg.type === 'reserve_request') return handleReserve(msg);
            if (msg.type === 'delete_request') return handleDelete(msg.id);
            
            // Relay all other messages (WebRTC, Text, etc.)
            relaySignal(addressId, msg, ws);
        } catch (e) { console.error(e); }
    });

    // Determine Roles on Join
    const peers = Array.from(wss.clients).filter(c => 
        c !== ws && c.protocol === addressId && c.readyState === WebSocket.OPEN
    );

    if (peers.length > 0) {
        ws.send(JSON.stringify({ type: 'ready', role: 'initiator' }));
        peers[0].send(JSON.stringify({ type: 'ready', role: 'polite' }));
    }
});

function relaySignal(addressId, msg, senderWs) {
    wss.clients.forEach(client => {
        if (client.protocol === addressId && client.readyState === WebSocket.OPEN && client !== senderWs) {
            client.send(JSON.stringify(msg));
        }
    });
}

function handleReserve(data) {
    registry.set(data.address, {
        id: data.address,
        nickname: data.nickname,
        expiresAt: Date.now() + (data.hours * 3600000),
        isPersistent: true
    });
}

function handleDelete(id) {
    registry.delete(id);
}

server.listen(PORT, () => console.log(`CORE_READY: PORT ${PORT}`));
