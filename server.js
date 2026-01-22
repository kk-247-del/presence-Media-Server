import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────── CORS ───────── */
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE"] }));

/* ───────── STORAGE ───────── */
const ROOT = "/tmp/presence-media";
fs.mkdirSync(ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const session = req.body.session;
    if (!session) return cb(new Error("Missing session"));
    const dir = path.join(ROOT, session);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_, __, cb) {
    cb(null, crypto.randomUUID());
  },
});

const upload = multer({ storage });

/* ───────── UPLOAD ───────── */
app.post("/media", upload.single("file"), (req, res) => {
  if (!req.file || !req.body.session) return res.sendStatus(400);

  res.json({
    id: req.file.filename,
    mime: req.file.mimetype,
    size: req.file.size,
  });
});

/* ───────── FETCH ───────── */
app.get("/media/:session/:id", (req, res) => {
  const file = path.join(ROOT, req.params.session, req.params.id);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.sendFile(file);
});

/* ───────── CLEANUP ───────── */
app.delete("/media/:session", (req, res) => {
  const dir = path.join(ROOT, req.params.session);
  fs.rmSync(dir, { recursive: true, force: true });
  res.sendStatus(204);
});

app.get("/", (_, res) => res.send("presence media server alive"));

app.listen(PORT, () =>
  console.log(`[MEDIA] SERVER RUNNING on ${PORT}`)
);
