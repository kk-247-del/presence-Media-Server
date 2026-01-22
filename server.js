// presence-media-server
// Node 18+ | Railway compatible | ESM

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';

/* ───────────────── APP SETUP ───────────────── */

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────────────── CORS (CRITICAL) ───────────────── */
/*
  This is what fixes:
  "No 'Access-Control-Allow-Origin' header is present"
*/
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

app.use(express.json());

/* ───────────────── MEMORY STORAGE ───────────────── */
/*
  No disk writes.
  Media lives only in RAM.
  Dies when session dies or server restarts.
*/
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB (adjust if needed)
  },
});

/* ───────────────── SESSION STORE ───────────────── */
/*
  sessions = Map<
    sessionId,
    {
      createdAt: number,
      media: Array<{
        id,
        name,
        type,
        size,
        buffer
      }>
    }
  >
*/
const sessions = new Map();

/* ───────────────── UTIL ───────────────── */

function log(...args) {
  console.log('[MEDIA]', ...args);
}

function createSessionIfMissing(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      createdAt: Date.now(),
      media: [],
    });
    log('SESSION CREATED →', sessionId);
  }
}

/* ───────────────── HEALTH CHECK ───────────────── */

app.get('/', (_, res) => {
  res.send('Presence Media Server OK');
});

/* ───────────────── UPLOAD MEDIA ───────────────── */
/*
  POST /media
  Headers:
    x-session-id: <presence session id>

  Body:
    multipart/form-data
    file=<binary>
*/

app.post('/media', upload.single('file'), (req, res) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing x-session-id header' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  createSessionIfMissing(sessionId);

  const mediaId = crypto.randomUUID();

  const media = {
    id: mediaId,
    name: req.file.originalname,
    type: req.file.mimetype,
    size: req.file.size,
    buffer: req.file.buffer,
  };

  sessions.get(sessionId).media.push(media);

  log('MEDIA RX', {
    sessionId,
    id: mediaId,
    name: media.name,
    type: media.type,
    size: media.size,
  });

  // Respond immediately — no blocking
  res.json({
    ok: true,
    id: mediaId,
    name: media.name,
    type: media.type,
    size: media.size,
  });
});

/* ───────────────── FETCH MEDIA ───────────────── */
/*
  GET /media/:sessionId/:mediaId
*/

app.get('/media/:sessionId/:mediaId', (req, res) => {
  const { sessionId, mediaId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).send('Session not found');
  }

  const media = session.media.find((m) => m.id === mediaId);
  if (!media) {
    return res.status(404).send('Media not found');
  }

  res.setHeader('Content-Type', media.type);
  res.setHeader('Content-Length', media.size);
  res.send(media.buffer);
});

/* ───────────────── END SESSION (HARD DELETE) ───────────────── */
/*
  Called when Presence session collapses.
  Destroys all media instantly.
*/

app.post('/session/end', (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    log('SESSION DESTROYED →', sessionId);
  }

  res.json({ ok: true });
});

/* ───────────────── START SERVER ───────────────── */

app.listen(PORT, () => {
  log(`SERVER RUNNING ON :${PORT}`);
});
