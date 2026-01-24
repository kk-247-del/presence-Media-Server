import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

/* ───────────────── CONFIG ───────────────── */

const PORT = process.env.PORT || 10000;
const KNOCK_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const REQUEST_TTL_MS = 60 * 60 * 1000;   // 1 hour

/* ───────────────── STATE ───────────────── */

const knockRegistry = new Map();
const knockRequests = new Map();

/* ───────────────── HTTP SERVER ───────────────── */

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/knock/send') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end('bad_json');
        return;
      }

      const { from, to, time } = payload;
      if (!from || !to || !time) {
        res.writeHead(400);
        res.end('invalid_payload');
        return;
      }

      const recipient = knockRegistry.get(to);
      if (!recipient || recipient.socket.readyState !== 1) {
        res.writeHead(404);
        res.end('recipient_not_available');
        return;
      }

      const id = crypto.randomUUID();
      knockRequests.set(id, {
        id,
        from,
        to,
        time,
        expiresAt: Date.now() + REQUEST_TTL_MS,
      });

      try {
        recipient.socket.send(
          JSON.stringify({
            type: 'knock_request',
            payload: { id, from, to, time },
          }),
        );
      } catch {
        knockRequests.delete(id);
        res.writeHead(500);
        res.end('delivery_failed');
        return;
      }

      res.writeHead(200);
      res.end('ok');
    });
    return;
  }

  res.writeHead(200);
  res.end('OK');
});

/* ───────────────── WEBSOCKET ───────────────── */

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  let registeredKnock = null;

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /* ─── REGISTER KNOCK ─── */
    if (msg.type === 'register_knock') {
      if (!msg.name) return;

      registeredKnock = msg.name;
      knockRegistry.set(msg.name, {
        socket: ws,
        expiresAt: Date.now() + KNOCK_TTL_MS,
      });
      return;
    }

    /* ─── JOIN (USED BY MomentEngine) ─── */
    if (msg.type === 'join') {
      const address = msg.address || msg.linkToken;
      if (!address) return;

      // CRITICAL: set address FIRST
      ws.__joinedAddress = address;

      knockRegistry.set(address, {
        socket: ws,
        expiresAt: Date.now() + KNOCK_TTL_MS,
      });

      // now search for peer
      for (const entry of knockRegistry.values()) {
        if (
          entry.socket !== ws &&
          entry.socket.readyState === 1 &&
          entry.socket.__joinedAddress === address
        ) {
          try {
            ws.send(JSON.stringify({ type: 'ready' }));
            entry.socket.send(JSON.stringify({ type: 'ready' }));
          } catch {}
          return;
        }
      }

      return;
    }

    /* ─── RESPONSE ─── */
    if (msg.type === 'knock_response') {
      const req = knockRequests.get(msg.id);
      if (!req) return;

      const sender = knockRegistry.get(req.from);
      if (sender && sender.socket.readyState === 1) {
        try {
          sender.socket.send(
            JSON.stringify({
              type: 'knock_response',
              payload: {
                id: msg.id,
                action: msg.action,
                time: msg.time,
              },
            }),
          );
        } catch {}
      }

      knockRequests.delete(msg.id);
      return;
    }

    /* ─── HEARTBEAT ─── */
    if (msg.type === 'ping') {
      if (ws.__joinedAddress && knockRegistry.has(ws.__joinedAddress)) {
        knockRegistry.get(ws.__joinedAddress).expiresAt =
          Date.now() + KNOCK_TTL_MS;
      }
    }
  });

  ws.on('close', () => {
    if (registeredKnock) knockRegistry.delete(registeredKnock);
    if (ws.__joinedAddress) knockRegistry.delete(ws.__joinedAddress);
  });
});

/* ───────────────── CLEANUP ───────────────── */

setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of knockRegistry) {
    if (entry.expiresAt < now || entry.socket.readyState !== 1) {
      try {
        entry.socket.close();
      } catch {}
      knockRegistry.delete(key);
    }
  }

  for (const [id, req] of knockRequests) {
    if (req.expiresAt < now) knockRequests.delete(id);
  }
}, 30_000);

/* ───────────────── START ───────────────── */

server.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
});
