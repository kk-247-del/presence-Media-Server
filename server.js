 // presence-media-server
// Node.js 18+ | Railway | ESM

import express from 'express';
import multer from 'multer';
import crypto from 'crypto';

/* ───────────────── APP ───────────────── */

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────────────── HARD CORS FIX (MANDATORY) ───────────────── */
/*
  This explicitly handles preflight (OPTIONS),
  which Flutter Web + file_picker_web REQUIRE.
*/
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, x-session-id'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  // Handle preflight immediately
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

/* ───────────────── JSON ───────────────── */

app.use(express.json());

/* ───────────────── UPLOAD (MEMORY ONLY) ───────────────── */
/*
  No disk.
  No persistence.
  Media lives only for the session.
*/

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

/* ───────────────── SESSION STORE ───────────────── */
/*
  sessions = Map<
    sessionId,
    {
      createdAt: number,
      media: Map<
        mediaId,
        {
          id,
          name,
          type,
          size,
          buffer
        }
      >
    }
  >
*/

const sessions = new Map();

/* ───────────────── UTIL ───────────────── */

function log(...args) {
  console.log('[MEDIA]', ...args);
}

function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      createdAt: Date.now(),
      media: new Map(),
    });
    log('SESSION CREATED →', sessionId);
  }
}

/* ───────────────── HEALTH ───────────────── */

app.get('/', (_, res) => {
  res.send('Presence Media Server OK');
});

/* ───────────────── UPLOAD MEDIA ───────────────── */
/*
  POST /media
  Headers:
    x-session-id: <presence address>

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

  ensureSession(sessionId);

  const mediaId = crypto.randomUUID();

  const media = {
    id: mediaId,
    name: req.file.originalname,
    type: req.file.mimetype,
    size: req.file.size,
    buffer: req.file.buffer,
  };

  sessions.get(sessionId).media.set(mediaId, media);

  log('MEDIA RX', {
    sessionId,
    id: mediaId,
    name: media.name,
    type: media.type,
    size: media.size,
  });

  // Immediate response — no blocking
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

  const media = session.media.get(mediaId);
  if (!media) {
    return res.status(404).send('Media not found');
  }

  res.setHeader('Content-Type', media.type);
  res.setHeader('Content-Length', media.size);
  res.send(media.buffer);
});

/* ───────────────── END SESSION (HARD WIPE) ───────────────── */
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

/* ───────────────── START ───────────────── */

app.listen(PORT, () => {
  log(`SERVER RUNNING ON :${PORT}`);
});
