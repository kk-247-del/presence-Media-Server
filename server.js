 import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────────────── CORS ───────────────── */

app.use(
  cors({
    origin: '*', // allow Flutter web
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  })
);

/* ───────────────── STORAGE ───────────────── */

const upload = multer({ storage: multer.memoryStorage() });
const store = new Map(); // token -> Buffer

/* ───────────────── LOG ───────────────── */

function log(...args) {
  console.log('[MEDIA]', ...args);
}

/* ───────────────── UPLOAD ───────────────── */

app.post('/media', upload.single('file'), (req, res) => {
  log('UPLOAD');

  if (!req.file) {
    log('UPLOAD FAILED → no file');
    return res.status(400).json({ error: 'No file' });
  }

  const token = crypto.randomUUID();
  store.set(token, req.file.buffer);

  log('STORED → token=', token, 'bytes=', req.file.buffer.length);

  res.json({ token });
});

/* ───────────────── FETCH ───────────────── */

app.get('/media/:token', (req, res) => {
  const { token } = req.params;
  log('FETCH →', token);

  const data = store.get(token);
  if (!data) {
    log('MISS →', token);
    return res.sendStatus(404);
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(data);
});

/* ───────────────── START ───────────────── */

app.listen(PORT, () => {
  log(`RUNNING on :${PORT}`);
});
