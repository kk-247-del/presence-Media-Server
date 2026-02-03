import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 8080;
const CVC_REGEX = /^[BCDFGHJKLMNPQRSTVWYZ][AEIU][BCDFGHJKLMNPQRSTVWYZ]\d{3}$/;

const server = createServer((req, res) => {
    res.writeHead(200);
    res.end("Presence Validated Signal Plane Active\n");
});

const wss = new WebSocketServer({ server });
const registry = new Map(); // Address -> WebSocket Mapping
const activeProposals = new Map(); // ProposalID -> { from, to }

wss.on('connection', (ws, req) => {
    const protocol = req.headers['sec-websocket-protocol'];
    let sessionAddress = protocol ? protocol.split(',')[0].trim().toUpperCase() : null;

    if (sessionAddress && CVC_REGEX.test(sessionAddress)) {
        registry.set(sessionAddress, ws);
        console.log(`🔌 [ONLINE] ${sessionAddress}`);
    }

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'send_proposal':
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
                    const proposal = activeProposals.get(data.id);
                    if (!proposal) return;

                    if (data.action === 'accept') {
                        // Notify BOTH peers to transition to the "Moment"
                        // This triggers the 'presence_update' listener in MeetingEngine
                        _notifyPeerState(proposal.from, true, "PEER");
                        _notifyPeerState(proposal.to, true, "PEER");
                        console.log(`🔗 [MOMENT STARTED] ${proposal.from} <-> ${proposal.to}`);
                    }
                    activeProposals.delete(data.id);
                    break;

                default:
                    // Relays Live Text, Reveal frames, and Haptics
                    const relayTo = data.to || data.target;
                    _relay(data.from || sessionAddress, relayTo, data);
                    break;
            }
        } catch (e) { console.error("Signal Error:", e); }
    });

    ws.on('close', () => {
        if (sessionAddress) registry.delete(sessionAddress);
    });
});

/**
 * Sends a state update to a specific address
 */
function _notifyPeerState(address, isPresent, role) {
    const targetWs = registry.get(address.toUpperCase());
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'presence_update',
            isPresent: isPresent,
            role: role
        }));
    }
}

/**
 * Raw Signal Relay
 */
function _relay(from, to, payload) {
    if (!to) return;
    const targetWs = registry.get(to.toUpperCase());
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ ...payload, from }));
    }
}

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Plane Live on ${PORT}`));
