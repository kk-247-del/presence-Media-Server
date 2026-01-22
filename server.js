import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
const upload = multer({ dest: 'tmp/' });

const PORT = process.env.PORT || 8080;

/*
  mediaStore = Map<
    token,
    { filePath, expires }
  >
*/
const mediaStore = new Map();

function log(...a) {
  console.log('[HI_PRESENCE][MEDIA]', ...a);
}

/* ───────── UPLOAD ───────── */
app.post('/media', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'NO_FILE' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + 5 * 60 * 1000;

  mediaStore.set(token, {
    filePath: req.file.path,
    expires,
  });

  log(`UPLOAD ${token}`);
  res.json({ token });
});

/* ───────── ONE-TIME FETCH ───────── */
app.get('/media/:token', (req, res) => {
  const entry = mediaStore.get(req.params.token);
  if (!entry) {
    return res.sendStatus(410);
  }

  mediaStore.delete(req.params.token);

  res.sendFile(
    path.resolve(entry.filePath),
    {},
    () => fs.unlink(entry.filePath, () => {})
  );

  log(`FETCH ${req.params.token}`);
});

/* ───────── TTL SWEEP ───────── */
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of mediaStore) {
    if (entry.expires < now) {
      fs.unlink(entry.filePath, () => {});
      mediaStore.delete(token);
      log(`EXPIRE ${token}`);
    }
  }
}, 60_000);

app.listen(PORT, () => {
  log(`MEDIA SERVER RUNNING :${PORT}`);
});
