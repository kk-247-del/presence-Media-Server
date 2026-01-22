 import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────── CORS (CRITICAL) ───────── */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type"],
  })
);

/* ───────── STORAGE ───────── */
const ROOT = "/tmp/presence-media";
fs.mkdirSync(ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const { session } = req.body;
    if (!session) return cb(new Error("Missing session"));
    const dir = path.join(ROOT, session);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const id = crypto.randomUUID();
    cb(null, id);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/* ───────── UPLOAD ───────── */
app.post("/media", upload.single("file"), (req, res) => {
  const { session } = req.body;
  if (!req.file || !session) {
    console.error("[MEDIA] upload failed");
    return res.status(400).end();
  }

  console.log(
    `[MEDIA] UPLOAD session=${session} id=${req.file.filename} type=${req.file.mimetype}`
  );

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
  console.log(`[MEDIA] FETCH ${file}`);
  res.sendFile(file);
});

/* ───────── SESSION DESTROY ───────── */
app.delete("/media/:session", (req, res) => {
  const dir = path.join(ROOT, req.params.session);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[MEDIA] DESTROY session=${req.params.session}`);
  }
  res.sendStatus(204);
});

/* ───────── HEALTH ───────── */
app.get("/", (_, res) => res.send("presence media server alive"));

app.listen(PORT, () =>
  console.log(`[MEDIA] SERVER RUNNING on ${PORT}`)
);
