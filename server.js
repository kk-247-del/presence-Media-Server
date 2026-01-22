const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────── CORS (ABSOLUTE) ───────── */

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, x-session-id'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json());

/* ───────── UPLOAD ───────── */

const upload = multer({ storage: multer.memoryStorage() });

const sessions = new Map();

function ensureSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { media: new Map() });
    console.log('[MEDIA] SESSION CREATED', id);
  }
}

/* ───────── ROUTES ───────── */

app.get('/', (_, res) => res.send('Presence Media Server OK'));

app.post('/media', upload.single('file'), (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !req.file) {
    return res.status(400).json({ error: 'bad request' });
  }

  ensureSession(sessionId);

  const id = crypto.randomUUID();
  sessions.get(sessionId).media.set(id, req.file);

  console.log('[MEDIA] RX', sessionId, id, req.file.originalname);

  res.json({
    ok: true,
    id,
    name: req.file.originalname,
    type: req.file.mimetype,
    size: req.file.size,
  });
});

app.get('/media/:session/:id', (req, res) => {
  const session = sessions.get(req.params.session);
  if (!session) return res.sendStatus(404);

  const file = session.media.get(req.params.id);
  if (!file) return res.sendStatus(404);

  res.setHeader('Content-Type', file.mimetype);
  res.send(file.buffer);
});

app.post('/session/end', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    sessions.delete(sessionId);
    console.log('[MEDIA] SESSION DESTROYED', sessionId);
  }
  res.json({ ok: true });
});

/* ───────── START ───────── */

app.listen(PORT, () => {
  console.log('[MEDIA] SERVER RUNNING ON', PORT);
});
