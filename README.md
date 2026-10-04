# DropIt

Aplikasi berbagi file sederhana untuk mengirim & menerima file antar perangkat dengan cepat dan aman.

> Website live: <https://dropit.philipthamsir.dev>

## ✨ Fitur

- 📤 **Send** — kirim banyak file sekaligus via *drag & drop* atau pilih file, dapatkan kode & QR untuk dibagikan.
- 📥 **Receive** — terima file lewat kode, scan QR, atau tampilkan QR sendiri (dua arah).
- 🔢 **Kode 6 digit** — gampang diketik di laptop atau disebut lewat telepon.
- 📷 **Scan QR dalam halaman** — scan langsung dari kamera tanpa keluar aplikasi.
- 🔄 **QR dua arah** — penerima bisa tampilkan QR sendiri, biar pengirim yang scan.
- ✅ **Pilih file saat unduh** — checkbox per file + tombol "Pilih Semua".
- ⚡ **Upload streaming** — file besar tidak membebani RAM server (mendukung hingga 1 GB per file).
- 🛡️ **Anti-spam** — grace TTL, batas ukuran per IP, dan batas total storage.
- 🚫 **Blokir ekstensi berbahaya** — menolak file executable/script saat upload.
- 🔒 **Sanitasi nama file** — mencegah *path traversal*.
- 🔐 **HTTPS** — lalu lintas terenkripsi (Let's Encrypt).

## 🛠️ Teknologi

- **Backend:** Node.js + Express
- **Upload streaming:** busboy
- **Frontend:** HTML + CSS + JavaScript (tanpa framework)
- **QR generator (client-side):** qrcode-generator (Kazuhiko Arase)
- **QR scanner (client-side):** jsQR
- **Deploy:** PM2 + Nginx (reverse proxy) + Certbot

## 📁 Struktur Proyek

```
dropit/
├── server.js            # Backend utama (Express)
├── public/
│   ├── index.html       # Frontend (send/receive)
│   ├── qrcode.js        # Library generator QR (client-side)
│   └── jsQR.js          # Library scanner QR (client-side)
├── uploads/             # Penyimpanan file (runtime, di-ignore git)
├── data/                # Metadata file (runtime, di-ignore git)
├── package.json
├── package-lock.json
└── .gitignore
```

## 🚀 Menjalankan Secara Lokal

Prasyarat: [Node.js](https://nodejs.org) versi 18 atau lebih baru.

```bash
# 1. Clone repo
git clone https://github.com/philipthamsir/DropIt.git
cd DropIt

# 2. Install dependencies
npm install

# 3. Jalankan server
npm start
```

Aplikasi berjalan di <http://localhost:8088>.

> Catatan: fitur scan kamera (`getUserMedia`) butuh konteks aman (HTTPS atau `localhost`).

## ⚙️ Konfigurasi (Environment Variables)

Semua pengaturan bisa diubah melalui environment variable:

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `8088` | Port aplikasi |
| `MAX_FILE_SIZE` | `1073741824` (1 GB) | Maksimal ukuran per file (byte) |
| `MAX_BATCH_SIZE` | `5368709120` (5 GB) | Maksimal total ukuran per batch (byte) |
| `MAX_FILES` | `50` | Maksimal jumlah file per batch |
| `TTL_MS` | `3600000` (1 jam) | Masa simpan penuh setelah diakses (milidetik) |
| `GRACE_TTL_MS` | `180000` (3 menit) | Masa tunggu sebelum file diakses (milidetik) |
| `MAX_TOTAL_SIZE_PER_IP` | `524288000` (500 MB) | Batas total ukuran file aktif per IP (byte) |
| `MAX_TOTAL_STORAGE` | `3221225472` (3 GB) | Batas total ukuran file aktif global (byte) |
| `UPLOAD_DIR` | `./uploads` | Folder penyimpanan file |
| `DATA_DIR` | `./data` | Folder penyimpanan metadata |

Contoh:

```bash
PORT=9000 MAX_FILE_SIZE=524288000 TTL_MS=86400000 npm start
```

## 🔌 API

| Method | Endpoint | Keterangan |
|---|---|---|
| `POST` | `/api/upload` | Upload satu atau banyak file (multipart, field `file`). Mengembalikan `code`. |
| `GET` | `/api/info/:code` | Cek daftar file dalam batch (id, nama, ukuran, kedaluwarsa). |
| `GET` | `/api/download/:code/:fileId` | Unduh satu file dalam batch (streaming). |
| `GET` | `/api/health` | Health check. |

### Contoh alur

```bash
# Upload banyak file
curl -F "file=@dokumen.pdf" -F "file=@foto.jpg" https://dropit.philipthamsir.dev/api/upload
# => {"code":"482913","fileCount":2,"files":[...]}

# Lihat daftar file dalam batch
curl https://dropit.philipthamsir.dev/api/info/482913
# => {"code":"482913","files":[{"id":"abc123","fileName":"dokumen.pdf","size":...}, ...]}

# Unduh satu file (pakai id dari response info)
curl -O https://dropit.philipthamsir.dev/api/download/482913/abc123
```

## 🔒 Keamanan & Anti-spam

- **Kode 6 digit** — gampang diketik; dilindungi rate limiting ketat agar tidak bisa di-brute-force.
- **Grace TTL 3 menit** — file yang tidak pernah diakses otomatis terhapus dalam 3 menit.
- **Perpanjang saat diakses** — begitu kode dibuka, masa simpan diperpanjang jadi 1 jam.
- **Batas ukuran per IP (500 MB)** — total file aktif dari satu IP dibatasi.
- **Batas total storage (3 GB)** — melindungi disk server agar tidak penuh.
- **Rate limiting** pada endpoint upload, info, dan download.
- **Blokir ekstensi berbahaya** (`.exe`, `.sh`, `.apk`, `.js`, dll.) saat upload.
- **Sanitasi nama file** & disimpan dengan nama acak di server.
- **File di luar web root** sehingga tidak bisa diakses langsung via URL.
- **File tidak pernah dieksekusi** server-side (disimpan sebagai blob + dikirim `application/octet-stream`).

## 📦 Deploy ke VPS (PM2 + Nginx)

```bash
# 1. Clone & install di server
cd ~
git clone https://github.com/philipthamsir/DropIt.git
cd DropIt
npm install --omit=dev

# 2. Jalankan dengan PM2
PORT=8088 pm2 start server.js --name dropit
pm2 save   # auto-start saat reboot
```

Konfigurasi Nginx (reverse proxy dengan dukungan file besar):

```nginx
server {
    server_name dropit.philipthamsir.dev;
    client_max_body_size 1500M;
    proxy_read_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

Aktifkan HTTPS:

```bash
sudo certbot --nginx -d dropit.philipthamsir.dev
```

## 📄 Lisensi

Proyek ini dibuat untuk keperluan pribadi.
