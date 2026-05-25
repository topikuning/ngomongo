# ngomongo — WhatsApp AI Bot

WhatsApp bot dengan otak AI yang bisa kamu kontrol penuh: pilih provider AI, atur kepribadian (role), kelola whitelist, dan ajari bot meniru style bahasa dari export chat WhatsApp. Seluruh sistem berjalan di Railway dalam satu project.

## Arsitektur

```
                    ┌─────────────────────────────────────────┐
                    │             Railway Project              │
                    │                                          │
   WhatsApp ──►  ┌────────┐  webhook  ┌──────────────┐         │
                 │  WAHA  │──────────►│   Backend     │         │
                 │ (Docker)│◄──reply──│  (Fastify)    │         │
                 └────────┘           └──────┬───────┘         │
                                              │                 │
                                       ┌──────┴─────┐          │
                                       │            │          │
                                  ┌────▼───┐   ┌────▼────┐     │
                                  │Postgres│   │  Redis  │     │
                                  └────────┘   └─────────┘     │
                    └─────────────────────────────────────────┘
                                         │
                                         ▼
                              AI Provider (Google/OpenAI/Deepseek/Groq)
```

- **Backend** — Node.js 22 + Fastify 5 + TypeScript + LangChain.js + Prisma 6
- **WA Gateway** — WAHA (Docker, official `devlikeapro/waha`)
- **Database** — PostgreSQL 17 (Railway native)
- **Cache & memory buffer** — Redis 7 (Railway native)

## Fitur

1. **Webhook WAHA** — terima pesan masuk, balas via WAHA REST API.
2. **Whitelist nomor** — hanya nomor yang terdaftar yang dibalas; di luar itu pesan diabaikan total tanpa log.
3. **Role AI dinamis** — system prompt disimpan di DB, bisa di-assign per nomor atau jadi default global.
4. **Konteks awal & style bahasa per nomor** — upload export WA (.zip/.txt) → AI mengekstrak konteks dan meniru style bahasa kontak tersebut.
5. **Provider AI swappable** — ganti Google/OpenAI/Deepseek/Groq tanpa redeploy, cukup update di dashboard.
6. **Manajemen memori token-efisien** — Redis menyimpan ringkasan + 10 pesan terakhir; setiap 15 pesan baru auto-summarize.
7. **Admin dashboard** — UI tunggal Bahasa Indonesia untuk semua pengaturan.

---

## 1. Setup Railway (step-by-step)

### A. Buat project & sambungkan repo

1. Login ke [railway.app](https://railway.app), klik **New Project → Deploy from GitHub repo**, pilih repo ini.
2. Railway otomatis mendeteksi `Dockerfile` dan `railway.toml`. Service backend pertama akan terbuat.

### B. Tambahkan PostgreSQL 17

1. Di project Railway: **+ New → Database → Add PostgreSQL**.
2. Setelah service `Postgres` jalan, buka tab **Variables** service backend, lalu **Add Reference Variable** → pilih variabel `DATABASE_URL` dari service Postgres.
3. Railway akan menyuntikkan `DATABASE_URL` secara otomatis ke backend — tidak perlu di-set manual.

### C. Tambahkan Redis 7

1. Di project Railway: **+ New → Database → Add Redis**.
2. Sama seperti Postgres, tambahkan **Reference Variable** `REDIS_URL` ke service backend.

### D. Tambahkan service WAHA

1. **+ New → Docker Image** lalu masukkan image:
   ```
   devlikeapro/waha:latest
   ```
   (Untuk fitur lengkap, kamu boleh pakai `devlikeapro/waha-plus:latest` jika punya lisensi.)
2. Di tab **Settings** service WAHA, buka **Networking → Generate Domain** agar WAHA punya URL publik (untuk QR scan login). Selain itu, gunakan **private network** untuk akses internal antar service.
3. Di tab **Variables** service WAHA, set:
   ```
   WHATSAPP_API_KEY=<api-key-bebas-buat-sendiri>
   WHATSAPP_DEFAULT_ENGINE=WEBJS
   PORT=3000
   ```
4. Tambahkan **Volume** ke path `/app/.sessions` agar session WhatsApp persisten antar restart.

### E. Sambungkan backend ke WAHA

Buka tab **Variables** service backend, tambahkan:

```
WAHA_URL=http://waha.railway.internal:3000     # gunakan URL internal Railway
WAHA_API_KEY=<sama dengan WHATSAPP_API_KEY di service WAHA>
WAHA_SESSION=default
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<password kuat>
PORT=3000
NODE_ENV=production
```

> Cara cek URL internal Railway: di service WAHA → Settings → Networking → "Private Networking" → copy hostname (`<service-name>.railway.internal`).

### F. Deploy & migrasi DB

`Dockerfile` sudah menjalankan `npx prisma migrate deploy` saat container start. Push commit → Railway auto-deploy backend. Setelah deploy sukses, buka URL backend → kamu akan diminta basic auth (gunakan `ADMIN_USERNAME` / `ADMIN_PASSWORD`).

### G. Set webhook WAHA → backend

1. Buka URL publik service WAHA (yang kamu generate di langkah D.2).
2. Login WhatsApp via QR (gunakan endpoint Swagger UI WAHA atau API `/api/sessions/start`).
3. Buat / update session `default` dengan webhook URL ke backend:
   ```bash
   curl -X POST "<WAHA_PUBLIC_URL>/api/sessions/default" \
     -H "X-Api-Key: <WAHA_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "default",
       "start": true,
       "config": {
         "webhooks": [
           {
             "url": "https://<backend-railway-domain>/webhook",
             "events": ["message"]
           }
         ]
       }
     }'
   ```
4. Setelah QR di-scan dari HP, WhatsApp akan ter-link dan setiap pesan masuk akan dikirim ke `/webhook` backend.

---

## 2. Konfigurasi env variables

| Variable                  | Wajib | Keterangan                                                      |
| ------------------------- | :---: | --------------------------------------------------------------- |
| `DATABASE_URL`            | ✅    | Otomatis dari service Postgres Railway                         |
| `REDIS_URL`               | ✅    | Otomatis dari service Redis Railway                            |
| `WAHA_URL`                | ✅    | URL internal WAHA (mis. `http://waha.railway.internal:3000`)   |
| `WAHA_API_KEY`            | ✅    | Sama dengan `WHATSAPP_API_KEY` di service WAHA                 |
| `WAHA_SESSION`            |       | Nama session WhatsApp (default `default`)                       |
| `ADMIN_USERNAME`          | ✅    | Username dashboard admin                                        |
| `ADMIN_PASSWORD`          | ✅    | Password dashboard admin                                        |
| `PORT`                    |       | Default `3000`                                                  |
| `MEMORY_SUMMARIZE_EVERY`  |       | Berapa pesan baru sebelum auto-summarize (default `15`)         |
| `MEMORY_RECENT_LIMIT`     |       | Berapa pesan terakhir yang ditahan di buffer (default `10`)     |

Salin dari `.env.example`.

---

## 3. Jalankan secara lokal (docker-compose)

```bash
cp .env.example .env
# Edit .env: ADMIN_PASSWORD, WAHA_API_KEY, dll.

docker compose up -d
```

Service yang berjalan:

- Backend → http://localhost:3000 (dashboard: http://localhost:3000/dashboard/)
- WAHA → http://localhost:3001 (Swagger UI: http://localhost:3001/)
- Postgres → localhost:5432
- Redis → localhost:6379

### Login WhatsApp di WAHA lokal

```bash
curl -X POST "http://localhost:3001/api/sessions/default" \
  -H "X-Api-Key: $WAHA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "default",
    "start": true,
    "config": {
      "webhooks": [
        { "url": "http://backend:3000/webhook", "events": ["message"] }
      ]
    }
  }'
```

Lalu scan QR code dari endpoint `/api/sessions/default/auth/qr` (atau via Swagger UI).

### Development mode (tanpa Docker untuk backend)

```bash
npm install
npx prisma migrate dev
npm run dev
```

Pastikan Postgres, Redis, dan WAHA tetap jalan via `docker compose up -d postgres redis waha`.

---

## 4. Memakai dashboard admin

Buka `https://<backend-domain>/dashboard/`, login dengan kredensial admin.

### Langkah pertama setelah deploy

1. **AI Provider** — tambahkan minimal 1 provider, isi API key, centang **Aktifkan sekarang**.
2. **Role AI** — buat 1 role dan tandai sebagai **default global**. Contoh system prompt:
   ```
   Kamu adalah asisten WhatsApp yang ramah, jawab dalam Bahasa Indonesia,
   ringkas (maks 2 paragraf), dan WAJIB meniru style bahasa lawan bicara.
   ```
3. **Whitelist Nomor** — tambahkan nomor pertama (format `6281234567890`).
4. Kirim pesan dari nomor tersebut ke nomor WhatsApp yang terhubung WAHA — bot akan membalas.

### Fitur upload export chat WhatsApp

Di halaman **Whitelist Nomor**, klik tombol **Upload Export** pada baris nomor yang ingin diberi konteks dari riwayat chat.

**Cara mendapatkan file export:**

1. Di WhatsApp HP, buka chat dengan kontak tersebut → titik tiga → **More → Export chat → Without media**.
2. WhatsApp menghasilkan file `.txt` (atau `.zip` berisi `.txt`).
3. Kirim file tersebut ke email / pindahkan ke komputer.

**Cara upload:**

1. Buka dashboard → tab **Whitelist Nomor**.
2. Pada baris nomor target, klik **Upload Export** → pilih file `.txt` atau `.zip`.
3. Sistem akan:
   - Parse semua baris pesan format `[DD/MM/YY, HH:MM:SS] Nama: isi`
   - Kirim sample ke AI provider aktif untuk ekstraksi
   - Hasilnya disimpan sebagai `initial_summary` di tabel `memory_snapshots`
4. Setelah selesai, status **Initial Summary** di tabel berubah jadi `siap` (hijau).
5. Setiap pesan baru dari nomor itu akan menggunakan summary ini — AI akan meniru style bahasa yang terdeteksi.

> Jika kamu hanya punya teks deskripsi (tidak punya file export), isi field **Konteks Awal (teks manual)** lalu klik **Bangun dari Teks** untuk menghasilkan initial summary versi minimal.

### Ganti AI provider tanpa redeploy

Buka tab **AI Provider** → klik **Aktifkan** pada provider lain. Cache di-invalidate otomatis, request berikutnya pakai provider baru.

### Ganti kepribadian AI per nomor

Edit nomor di tab **Whitelist Nomor** → ubah Role ID ke role yang diinginkan. Jika kosong, akan jatuh ke default global.

### Melihat riwayat chat

Tab **Riwayat Chat** → pilih nomor → opsional filter tanggal → klik **Tampilkan**.

---

## Struktur folder

```
src/
  routes/
    webhook.ts        — POST /webhook dari WAHA
    admin.ts          — REST API untuk dashboard
    upload.ts         — upload file export WA
  services/
    ai-router.ts      — load provider aktif → instantiate LangChain model
    memory.ts         — load/save/summarize memory per nomor (Redis + DB)
    waha-client.ts    — kirim pesan via WAHA REST API
    whitelist.ts      — cek whitelist, system prompt resolver
    chat-parser.ts    — parse export WA (.zip/.txt) → ekstrak via AI
  lib/
    prisma.ts
    redis.ts
    langchain.ts      — factory ChatModel berdasarkan provider
  dashboard/
    index.html        — single-page admin UI
  app.ts              — Fastify setup + routing
  server.ts           — entry point
prisma/
  schema.prisma       — definisi schema DB
Dockerfile
railway.toml
docker-compose.yml
.env.example
```

---

## Catatan keamanan

- Gunakan `ADMIN_PASSWORD` yang kuat — basic auth adalah satu-satunya proteksi dashboard.
- Jangan commit `.env`. Gunakan tab Variables di Railway.
- `WAHA_API_KEY` melindungi service WAHA dari akses publik — set value acak panjang dan rahasiakan.
- API keys provider AI disimpan di DB. Jika kamu rotate key, update via dashboard.

## Troubleshooting

- **Backend tidak mau balas pesan** → cek log Railway backend, pastikan nomor sudah di-whitelist dan minimal 1 provider AI aktif.
- **WAHA tidak kirim webhook** → buka Swagger UI WAHA → `GET /api/sessions/default` → cek field `config.webhooks` sudah berisi URL `/webhook` backend yang benar.
- **Prisma migration error** → cek `DATABASE_URL` valid. Jalankan `npx prisma migrate deploy` secara manual via Railway shell jika perlu.
- **Initial summary gagal dibuat** → pastikan provider AI aktif mendukung input panjang dan API key valid.
