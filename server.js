 import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 8080;
const CVC_REGEX = /^[BCDFGHJKLMNPQRSTVWYZ][AEIU][BCDFGHJKLMNPQRSTVWYZ]\d{3}$/;

const server = createServer((req, res) => {
    res.writeHead(200);
    res.end("Presence Plane: Express & Registry Link Active\n");
});

const wss = new WebSocketServer({ server });

const registry = new Map(); // Address -> WebSocket
const waitingPeers = new Set(); // Addresses currently in 'Waiting' mode
const activeProposals = new Map(); // Proposal ID -> { from, to }

wss.on('connection', (ws, req) => {
    const protocol = req.headers['sec-websocket-protocol'];
    let sessionAddress = protocol ? protocol.split(',')[0].trim().toUpperCase() : null;

    // AUTO-REGISTRATION: Handles Express Addresses immediately on socket open
    if (sessionAddress && CVC_REGEX.test(sessionAddress)) {
        registry.set(sessionAddress, ws);
        console.log(`🔌 [PROTOCOL AUTH] ${sessionAddress} entered the plane.`);
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const fromAddr = data.from || sessionAddress;

            switch (data.type) {
                case 'register_identity':
                    if (CVC_REGEX.test(data.address)) {
                        registry.set(data.address.toUpperCase(), ws);
                        // If they register, they are online but not necessarily "waiting" yet
                    }
                    break;

                case 'lookup_address':
                    const target = data.address.toUpperCase();
                    ws.send(JSON.stringify({
                        type: 'lookup_response',
                        address: target,
                        found: registry.has(target), // Found if online (Express or Registry)
                        status: waitingPeers.has(target) ? 'waiting' : (registry.has(target) ? 'online' : 'offline')
                    }));
                    break;

                case 'send_proposal':
                    // This is the "Knock" flow
                    const proposalId = `KNK-${Date.now()}`;
                    activeProposals.set(proposalId, { from: data.fromAddress, to: data.toAddress });
                    _relay(data.fromAddress, data.toAddress, {
                        type: 'incoming_proposal',
                        id: proposalId,
                        fromAddress: data.fromAddress,
                        fromName: data.fromName,
                        proposedTime: data.proposedTime
                    });
                    break;

                case 'respond_to_proposal':
                    const prop = activeProposals.get(data.id);
                    if (prop && data.action === 'accept') {
                        _establishMoment(prop.from, prop.to);
                    }
                    activeProposals.delete(data.id);
                    break;

                // NEW: Handle the "Waiting" state for direct Express connections
                case 'signal': 
                    // If a user sends a signal of type 'waiting', we track them
                    if (data.data === 'waiting') {
                        waitingPeers.add(fromAddr);
                        console.log(`⏳ [WAITING] ${fromAddr} is ready for express join.`);
                    }
                    break;

                default:
                    // DIRECT JOIN LOGIC: If I send a signal to someone who is waiting,
                    // and it's not a proposal (it's a direct action), we connect them.
                    const targetTo = data.to || data.target;
                    if (targetTo && waitingPeers.has(targetTo.toUpperCase())) {
                        _establishMoment(fromAddr, targetTo);
                    } else {
                        _relay(fromAddr, targetTo, data);
                    }
                    break;
            }
        } catch (e) { console.error("Signal Error:", e); }
    });

    ws.on('close', () => {
        if (sessionAddress) {
            registry.delete(sessionAddress);
            waitingPeers.delete(sessionAddress);
        }
    });
});

/**
 * Triggers the Flutter 'presence_update' to move both users to the MomentSurface
 */
function _establishMoment(peerA, peerB) {
    _notify(peerA, { type: 'presence_update', isPresent: true, role: "PEER" });
    _notify(peerB, { type: 'presence_update', isPresent: true, role: "PEER" });
    
    // Once they are in a Moment, they are no longer "waiting" for others
    waitingPeers.delete(peerA.toUpperCase());
    waitingPeers.delete(peerB.toUpperCase());
    
    console.log(`✨ [MOMENT] ${peerA} <-> ${peerB}`);
}

function _notify(addr, payload) {
    const ws = registry.get(addr.toUpperCase());
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function _relay(from, to, payload) {
    if (!to) return;
    const ws = registry.get(to.toUpperCase());
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...payload, from }));
}

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Plane Live on ${PORT}`));
