# DropIt

Aplikasi berbagi file sederhana untuk mengirim & menerima file antar perangkat dengan cepat dan aman.

> Website live: <https://dropit.philipthamsir.dev>

## ✨ Fitur

- 📤 **Send** — kirim file via *drag & drop* atau pilih file, dapatkan kode unik untuk dibagikan.
- 📥 **Receive** — masukkan kode untuk mengunduh file.
- ⚡ **Upload streaming** — file besar tidak membebani RAM server (mendukung hingga 1 GB).
- 🔑 **Kode unik 8 karakter** per file (tanpa karakter membingungkan).
- ⏱️ **Auto-delete 1 jam** — file otomatis terhapus setelah kedaluwarsa.
- 🛡️ **Rate limiting** — mencegah percobaan brute-force pada kode unduh.
- 🔒 **Sanitasi nama file** — mencegah *path traversal*.
- 🔐 **HTTPS** — lalu lintas terenkripsi (Let's Encrypt).

## 🛠️ Teknologi

- **Backend:** Node.js + Express
- **Upload streaming:** busboy
- **Frontend:** HTML + CSS + JavaScript (tanpa framework)
- **Deploy:** PM2 + Nginx (reverse proxy) + Certbot

## 📁 Struktur Proyek

```
dropit/
├── server.js            # Backend utama (Express)
├── public/
│   └── index.html       # Frontend (send/receive)
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

## ⚙️ Konfigurasi (Environment Variables)

Semua pengaturan bisa diubah melalui environment variable:

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `8088` | Port aplikasi |
| `MAX_FILE_SIZE` | `1073741824` (1 GB) | Maksimal ukuran file (byte) |
| `TTL_MS` | `3600000` (1 jam) | Masa berlaku file (milidetik) |
| `UPLOAD_DIR` | `./uploads` | Folder penyimpanan file |
| `DATA_DIR` | `./data` | Folder penyimpanan metadata |

Contoh:

```bash
PORT=9000 MAX_FILE_SIZE=524288000 TTL_MS=86400000 npm start
```

## 🔌 API

| Method | Endpoint | Keterangan |
|---|---|---|
| `POST` | `/api/upload` | Upload file (multipart, field `file`). Mengembalikan `code`. |
| `GET` | `/api/info/:code` | Cek info file (nama, ukuran, kedaluwarsa) tanpa mengunduh. |
| `GET` | `/api/download/:code` | Unduh file (streaming). |
| `GET` | `/api/health` | Health check. |

### Contoh alur

```bash
# Upload
curl -F "file=@dokumen.pdf" https://dropit.philipthamsir.dev/api/upload
# => {"code":"Ab3xK9zL","fileName":"dokumen.pdf",...}

# Unduh
curl -O https://dropit.philipthamsir.dev/api/download/Ab3xK9zL
```

## 🔒 Keamanan

- Kode acak 8 karakter (case-sensitive), sulit ditebak.
- File & metadata kedaluwarsa otomatis (TTL 1 jam), dihapus tiap 1 menit oleh *cleanup job*.
- Rate limiting pada endpoint upload & download.
- Nama file disanitasi dan disimpan dengan nama acak di server.
- File disimpan **di luar web root** sehingga tidak bisa diakses langsung via URL.

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
