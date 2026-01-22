import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────────────── CORS ───────────────── */

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.options('*', cors());

/* ───────────────── MEMORY STORE ───────────────── */

/*
  sessions = Map<
    sessionId: string,
    {
      media: Map<mediaId, { buffer, mime }>
      createdAt: number
    }
  >
*/
const sessions = new Map();

/* ───────────────── MULTER (MEMORY ONLY) ───────────────── */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

/* ───────────────── HELPERS ───────────────── */

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function log(...args) {
  console.log('[MEDIA]', ...args);
}

/* ───────────────── ROUTES ───────────────── */

/**
 * POST /media
 * body: multipart/form-data
 * fields:
 *   - sessionId (optional)
 *   - file
 */
app.post('/media', upload.single('file'), (req, res) => {
  try {
    const sessionId = req.body.sessionId || newId();
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'NO_FILE' });
    }

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        media: new Map(),
        createdAt: Date.now(),
      });
    }

    const mediaId = newId();
    const session = sessions.get(sessionId);

    session.media.set(mediaId, {
      buffer: file.buffer,
      mime: file.mimetype,
    });

    log('MEDIA UPLOADED', {
      sessionId,
      mediaId,
      mime: file.mimetype,
      size: file.size,
    });

    res.json({
      sessionId,
      mediaId,
      mime: file.mimetype,
    });
  } catch (e) {
    log('UPLOAD ERROR', e);
    res.status(500).json({ error: 'UPLOAD_FAILED' });
  }
});

/**
 * GET /media/:sessionId/:mediaId
 */
app.get('/media/:sessionId/:mediaId', (req, res) => {
  const { sessionId, mediaId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) return res.sendStatus(404);

  const media = session.media.get(mediaId);
  if (!media) return res.sendStatus(404);

  res.setHeader('Content-Type', media.mime);
  res.setHeader('Cache-Control', 'no-store');
  res.send(media.buffer);
});

/**
 * DELETE /session/:sessionId
 * Destroys everything for everyone
 */
app.delete('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    log('SESSION DESTROYED', sessionId);
  }

  res.json({ ok: true });
});

/* ───────────────── HEALTH ───────────────── */

app.get('/', (_, res) => {
  res.send('Presence Media Server OK');
});

/* ───────────────── START ───────────────── */

app.listen(PORT, () => {
  log(`SERVER RUNNING ON ${PORT}`);
});
