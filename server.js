const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const busboy = require('busboy');
const rateLimit = require('express-rate-limit');

const app = express();

// ---- Configuration (via env, with sensible defaults) ----
const PORT = process.env.PORT || 8088;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024); // 1 GB
const TTL_MS = Number(process.env.TTL_MS || 60 * 60 * 1000); // 1 hour
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');

// Ensure directories exist
for (const dir of [UPLOAD_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- Metadata store (in-memory + persisted to disk) ----
let metadata = {}; // code -> { fileName, storedName, size, createdAt, expiresAt, downloads, maxDownloads }
let persistTimer = null;

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load metadata:', e.message);
    metadata = {};
  }
}

function persistMetadata() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
    } catch (e) {
      console.error('Failed to persist metadata:', e.message);
    }
  }, 200);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code;
  do {
    code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      code += chars[bytes[i] % chars.length];
    }
  } while (metadata[code]);
  return code;
}

// Sanitize: keep only safe filename characters, strip any path components
function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  return cleaned || 'file';
}

// ---- Cleanup job: remove expired files ----
function cleanupExpired() {
  const now = Date.now();
  for (const code of Object.keys(metadata)) {
    const m = metadata[code];
    if (now > m.expiresAt || (m.maxDownloads && m.downloads >= m.maxDownloads)) {
      const filePath = path.join(UPLOAD_DIR, m.storedName);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) { /* ignore */ }
      delete metadata[code];
      persistMetadata();
      console.log(`[cleanup] removed ${code} (${m.fileName})`);
    }
  }
}
setInterval(cleanupExpired, 60 * 1000).unref();

// ---- Rate limiting (prevent brute-forcing download codes) ----
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 60, // 60 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan. Coba lagi nanti.' },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak upload. Coba lagi nanti.' },
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Upload endpoint (streaming via busboy) ----
app.post('/api/upload', uploadLimiter, (req, res) => {
  let fileInfo = null;
  let completed = false;
  let aborted = false;

  const bb = busboy({
    headers: req.headers,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 1,
    },
  });

  const code = generateCode();
  const storedName = `${code}_${crypto.randomBytes(6).toString('hex')}`;
  const filePath = path.join(UPLOAD_DIR, storedName);
  const writeStream = fs.createWriteStream(filePath);

  let receivedBytes = 0;

  bb.on('file', (fieldname, file, info) => {
    const originalName = sanitizeFilename(info.filename);
    fileInfo = { fileName: originalName, storedName, size: 0 };

    file.on('data', (chunk) => {
      receivedBytes += chunk.length;
    });

    file.on('limit', () => {
      aborted = true;
      writeStream.destroy();
      fs.unlink(filePath, () => {});
      res.status(413).json({ error: 'File terlalu besar. Maksimal 1 GB.' });
      req.unpipe(bb);
    });

    file.pipe(writeStream);
  });

  bb.on('close', () => {
    if (completed || aborted) return;
    completed = true;

    writeStream.end(() => {
      if (aborted) return;
      const now = Date.now();
      const meta = {
        fileName: fileInfo ? fileInfo.fileName : 'file',
        storedName,
        size: receivedBytes,
        createdAt: now,
        expiresAt: now + TTL_MS,
        downloads: 0,
        maxDownloads: null,
      };
      metadata[code] = meta;
      persistMetadata();

      res.json({
        code,
        fileName: meta.fileName,
        size: meta.size,
        expiresAt: meta.expiresAt,
      });
    });
  });

  bb.on('error', (err) => {
    if (!completed && !aborted) {
      completed = true;
      writeStream.destroy();
      fs.unlink(filePath, () => {});
      res.status(400).json({ error: 'Upload gagal: ' + err.message });
    }
  });

  req.pipe(bb);
});

// ---- Info endpoint (check code exists, without downloading) ----
app.get('/api/info/:code', (req, res) => {
  const code = req.params.code;
  const m = metadata[code];
  if (!m || Date.now() > m.expiresAt) {
    return res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.' });
  }
  res.json({ fileName: m.fileName, size: m.size, expiresAt: m.expiresAt });
});

// ---- Download endpoint (streaming) ----
app.get('/api/download/:code', downloadLimiter, (req, res) => {
  const code = req.params.code;
  const m = metadata[code];

  if (!m || Date.now() > m.expiresAt) {
    return res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.' });
  }
  if (m.maxDownloads && m.downloads >= m.maxDownloads) {
    return res.status(410).json({ error: 'File sudah mencapai batas unduh.' });
  }

  const filePath = path.join(UPLOAD_DIR, m.storedName);
  if (!fs.existsSync(filePath)) {
    delete metadata[code];
    persistMetadata();
    return res.status(404).json({ error: 'File tidak ditemukan di server.' });
  }

  m.downloads += 1;
  persistMetadata();

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(m.fileName)}`
  );
  res.setHeader('Content-Length', m.size);

  const readStream = fs.createReadStream(filePath);
  readStream.on('error', () => res.destroy());
  readStream.pipe(res);
});

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

loadMetadata();
app.listen(PORT, () => {
  console.log(`DropIt running on port ${PORT}`);
  console.log(`Max file size: ${MAX_FILE_SIZE} bytes, TTL: ${TTL_MS} ms`);
});
