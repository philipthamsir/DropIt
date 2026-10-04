const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const busboy = require('busboy');
const rateLimit = require('express-rate-limit');

const app = express();

// ---- Configuration (via env, with sensible defaults) ----
const PORT = process.env.PORT || 8088;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024); // 1 GB per file
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 5 * 1024 * 1024 * 1024); // 5 GB total per batch
const MAX_FILES = Number(process.env.MAX_FILES || 50); // max files per batch
const TTL_MS = Number(process.env.TTL_MS || 60 * 60 * 1000); // 1 hour
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');

// Ensure directories exist
for (const dir of [UPLOAD_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- Metadata store (in-memory + persisted to disk) ----
// code -> { files: [{ id, fileName, storedName, size }], createdAt, expiresAt }
let metadata = {};
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

// ---- Cleanup job: remove expired batches ----
function cleanupExpired() {
  const now = Date.now();
  for (const code of Object.keys(metadata)) {
    const m = metadata[code];
    if (now > m.expiresAt) {
      for (const f of m.files) {
        const filePath = path.join(UPLOAD_DIR, f.storedName);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) { /* ignore */ }
      }
      delete metadata[code];
      persistMetadata();
      console.log(`[cleanup] removed batch ${code} (${m.files.length} file)`);
    }
  }
}
setInterval(cleanupExpired, 60 * 1000).unref();

// ---- Rate limiting (prevent brute-forcing download codes) ----
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 120, // attempts per IP per window
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

// ---- Upload endpoint (multi-file, streaming via busboy) ----
app.post('/api/upload', uploadLimiter, (req, res) => {
  let completed = false;
  let aborted = false;

  const code = generateCode();
  const files = []; // collected file metadata
  const tempPaths = []; // paths written so far (for cleanup on failure)
  let totalBytes = 0;

  const bb = busboy({
    headers: req.headers,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: MAX_FILES,
      parts: MAX_FILES,
    },
  });

  bb.on('file', (fieldname, file, info) => {
    const originalName = sanitizeFilename(info.filename);
    const fileId = crypto.randomBytes(6).toString('hex');
    const storedName = `${code}_${fileId}`;
    const filePath = path.join(UPLOAD_DIR, storedName);
    const writeStream = fs.createWriteStream(filePath);
    tempPaths.push(filePath);

    const entry = { id: fileId, fileName: originalName, storedName, size: 0 };
    files.push(entry);

    file.on('data', (chunk) => {
      entry.size += chunk.length;
      totalBytes += chunk.length;
    });

    file.on('limit', () => {
      aborted = true;
      writeStream.destroy();
      req.unpipe(bb);
      cleanupTemp(tempPaths);
      res.status(413).json({ error: 'Salah satu file melebihi batas ukuran (maks 1 GB per file).' });
    });

    file.pipe(writeStream);
  });

  bb.on('close', () => {
    if (completed || aborted) return;
    completed = true;

    if (files.length === 0) {
      cleanupTemp(tempPaths);
      return res.status(400).json({ error: 'Tidak ada file yang dikirim.' });
    }
    if (totalBytes > MAX_BATCH_SIZE) {
      cleanupTemp(tempPaths);
      return res.status(413).json({ error: 'Total ukuran batch melebihi batas (maks 5 GB).' });
    }

    const now = Date.now();
    metadata[code] = {
      files,
      createdAt: now,
      expiresAt: now + TTL_MS,
    };
    persistMetadata();

    res.json({
      code,
      fileCount: files.length,
      totalSize: totalBytes,
      files: files.map((f) => ({ fileName: f.fileName, size: f.size })),
      expiresAt: now + TTL_MS,
    });
  });

  bb.on('error', (err) => {
    if (!completed && !aborted) {
      completed = true;
      cleanupTemp(tempPaths);
      res.status(400).json({ error: 'Upload gagal: ' + err.message });
    }
  });

  req.pipe(bb);
});

function cleanupTemp(paths) {
  for (const p of paths) {
    fs.unlink(p, () => {});
  }
}

// ---- Info endpoint (list files in a batch) ----
app.get('/api/info/:code', (req, res) => {
  const code = req.params.code;
  const m = metadata[code];
  if (!m || Date.now() > m.expiresAt) {
    return res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.' });
  }
  res.json({
    code,
    expiresAt: m.expiresAt,
    fileCount: m.files.length,
    files: m.files.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      size: f.size,
    })),
  });
});

// ---- Download endpoint (single file within a batch, streaming) ----
app.get('/api/download/:code/:fileId', downloadLimiter, (req, res) => {
  const { code, fileId } = req.params;
  const m = metadata[code];

  if (!m || Date.now() > m.expiresAt) {
    return res.status(404).json({ error: 'File tidak ditemukan atau sudah kedaluwarsa.' });
  }

  const file = m.files.find((f) => f.id === fileId);
  if (!file) {
    return res.status(404).json({ error: 'File tidak ditemukan dalam batch ini.' });
  }

  const filePath = path.join(UPLOAD_DIR, file.storedName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File tidak ditemukan di server.' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`
  );
  res.setHeader('Content-Length', file.size);

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
