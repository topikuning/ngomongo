# ngomongo — WhatsApp AI Bot

WhatsApp bot dengan otak AI yang bisa kamu kontrol penuh: pilih provider AI, atur kepribadian (role), kelola whitelist, dan ajari bot meniru style bahasa dari export chat WhatsApp. Seluruh sistem berjalan di Railway dalam satu project.

## Versi teknologi (semua LTS / stable terbaru per Mei 2026)

| Komponen          | Versi                              |
| ----------------- | ---------------------------------- |
| Node.js           | 24 LTS (Active LTS sejak Okt 2025) |
| TypeScript        | 5.8.x                              |
| Fastify           | 5.8.x                              |
| LangChain.js      | 1.4.x (`@langchain/core` 1.1.x)    |
| Prisma            | 6.19.x                             |
| PostgreSQL        | 17                                 |
| Redis             | 7                                  |
| ioredis           | 5.10.x                             |
| WAHA              | `devlikeapro/waha:latest`          |

> Catatan: Prisma 7 sudah rilis namun memperkenalkan breaking change besar (driver-adapter wajib, `datasource.url` di-remove dari schema). Project ini sengaja stay di Prisma 6.19.x yang masih actively-maintained dan stable, supaya migrasi sederhana via `prisma migrate deploy` tetap bekerja tanpa refactor.

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

## Fitur

1. **Webhook WAHA** — terima pesan masuk, balas via WAHA REST API.
2. **Whitelist nomor** — hanya nomor terdaftar yang dibalas; lainnya diabaikan total tanpa log.
3. **Role AI dinamis** — system prompt di DB; assignable per-nomor atau default global.
4. **Konteks awal & style bahasa per nomor** — upload export WA (.zip/.txt) → AI ekstrak konteks + style.
5. **Provider AI swappable** — ganti Google/OpenAI/Deepseek/Groq tanpa redeploy lewat dashboard.
6. **Manajemen memori token-efisien** — Redis: summary + 10 pesan terakhir; auto-summarize tiap 15 pesan.
7. **Admin dashboard** — single-page Bahasa Indonesia, basic auth.

---

## 1. Setup Railway (step-by-step lengkap)

### A. Buat project & hubungkan repo

1. Login ke [railway.com](https://railway.com) → **+ New Project → Deploy from GitHub repo** → pilih repo ini.
2. Railway auto-detect `Dockerfile` + `railway.toml`. Service backend pertama terbuat (sebut saja **`backend`**).
3. Tunggu build pertama — **akan gagal** karena `DATABASE_URL` & `REDIS_URL` belum ada. Itu normal; lanjut ke langkah berikutnya.

### B. Tambahkan PostgreSQL 17

1. Di canvas project: **+ Create → Database → Add PostgreSQL**.
2. Tunggu sampai status hijau (Postgres siap).
3. Klik service `backend` → tab **Variables** → **+ New Variable → Add Reference** → pilih service Postgres → variabel `DATABASE_URL`.
4. Railway akan inject `DATABASE_URL` otomatis ke backend tiap deploy.

### C. Tambahkan Redis 7

1. **+ Create → Database → Add Redis**.
2. Service `backend` → **Variables** → **Add Reference** → pilih service Redis → variabel `REDIS_URL`.

### D. Tambahkan service WAHA

1. **+ Create → Docker Image** → isi:
   ```
   devlikeapro/waha:latest
   ```
   (Pakai `devlikeapro/waha-plus:latest` jika punya lisensi WAHA Plus.)
2. Buka service WAHA → **Settings → Networking**:
   - **Generate Domain** (URL publik) → diperlukan untuk login QR via browser.
   - Tab **Private Networking** akan menampilkan hostname internal, mis. `waha.railway.internal`.
3. Tab **Variables** service WAHA:
   ```
   WHATSAPP_API_KEY=<api-key-acak-panjang-buat-sendiri>
   WHATSAPP_DEFAULT_ENGINE=WEBJS
   PORT=3000
   ```
4. Tab **Settings → Volumes** → mount path `/app/.sessions` (untuk persistensi login WhatsApp).

### E. Set env variables backend

Service `backend` → **Variables** → tambahkan satu per satu:

| Variable          | Value                                              |
| ----------------- | -------------------------------------------------- |
| `WAHA_URL`        | `http://waha.railway.internal:3000` (private URL)  |
| `WAHA_API_KEY`    | sama persis dengan `WHATSAPP_API_KEY` di service WAHA |
| `WAHA_SESSION`    | `default`                                          |
| `ADMIN_USERNAME`  | `admin` (atau bebas)                               |
| `ADMIN_PASSWORD`  | password kuat (mis. random 24 karakter)            |
| `NODE_ENV`        | `production`                                       |

`DATABASE_URL` dan `REDIS_URL` sudah otomatis ter-inject dari langkah B & C.

### F. Deploy backend (migrasi otomatis di preDeployCommand)

`railway.toml` sudah mengkonfigurasi:

```toml
[deploy]
preDeployCommand = ["npx prisma migrate deploy"]
startCommand = "node dist/server.js"
healthcheckPath = "/health"
healthcheckTimeout = 300
```

- `preDeployCommand` dijalankan Railway **sebelum** container mulai menerima trafik — di sinilah `prisma migrate deploy` berjalan.
- `startCommand` hanya menjalankan server → log `[boot] ngomongo ready · listening on 0.0.0.0:3000` muncul cepat → `/health` lulus dalam jendela 300 detik.

> ⚠️ JANGAN menggabungkan `prisma migrate deploy` ke dalam start command / `CMD` Docker. Jika digabung, migrasi memakan window healthcheck (default 30 detik) → Railway menganggap deploy gagal → container di-restart loop. Versi sebelum perbaikan ini punya bug tersebut; sekarang sudah dipisah.

Setelah env lengkap, klik **Deploy** ulang di service backend (atau push commit baru). Tunggu sampai status hijau. Buka URL publik backend → akan diminta basic auth → login dengan `ADMIN_USERNAME` / `ADMIN_PASSWORD` → dashboard muncul.

### G. Hubungkan WAHA → backend webhook

1. Buka URL publik WAHA (langkah D.2) → halaman **Swagger UI** WAHA muncul.
2. Klik tombol **Authorize** di pojok kanan → masukkan `WAHA_API_KEY`.
3. Buat / start session `default` dengan webhook ke backend:

   ```bash
   curl -X POST "<WAHA_PUBLIC_URL>/api/sessions" \
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

   > Jika session `default` sudah ada, gunakan `PUT /api/sessions/default` dengan body yang sama untuk update webhook.

4. Ambil QR code:
   ```bash
   curl "<WAHA_PUBLIC_URL>/api/default/auth/qr?format=image" \
     -H "X-Api-Key: <WAHA_API_KEY>" -o qr.png
   ```
   Buka `qr.png` → scan dari WhatsApp HP (**Setelan → Perangkat tertaut → Tautkan perangkat**).

5. Cek status session sudah `WORKING`:
   ```bash
   curl "<WAHA_PUBLIC_URL>/api/sessions/default" -H "X-Api-Key: <WAHA_API_KEY>"
   ```

Sejak detik ini, pesan masuk ke nomor WhatsApp yang tertaut akan diteruskan ke `/webhook` backend.

---

## 2. Konfigurasi env variables (.env.example)

| Variable                  | Wajib | Keterangan                                                      |
| ------------------------- | :---: | --------------------------------------------------------------- |
| `DATABASE_URL`            | ✅    | Otomatis dari service Postgres Railway                          |
| `REDIS_URL`               | ✅    | Otomatis dari service Redis Railway                             |
| `WAHA_URL`                | ✅    | URL internal WAHA, mis. `http://waha.railway.internal:3000`     |
| `WAHA_API_KEY`            | ✅    | Sama dengan `WHATSAPP_API_KEY` di service WAHA                  |
| `WAHA_SESSION`            |       | Nama session WhatsApp (default `default`)                       |
| `ADMIN_USERNAME`          | ✅    | Username dashboard admin                                        |
| `ADMIN_PASSWORD`          | ✅    | Password dashboard admin                                        |
| `PORT`                    |       | Default `3000`                                                  |
| `NODE_ENV`                |       | `production` di Railway                                         |
| `MEMORY_SUMMARIZE_EVERY`  |       | Berapa pesan baru sebelum auto-summarize (default `15`)         |
| `MEMORY_RECENT_LIMIT`     |       | Berapa pesan terakhir di buffer (default `10`)                  |
| `LOG_LEVEL`               |       | `info` (default), atau `debug`/`warn`                           |

---

## 3. Jalankan secara lokal (docker-compose)

```bash
cp .env.example .env
# Edit .env: ADMIN_PASSWORD, WAHA_API_KEY, dll.

docker compose up -d --build
```

Service yang berjalan & port-nya:

- Backend → http://localhost:3000 → dashboard di http://localhost:3000/dashboard/
- WAHA → http://localhost:3001 (Swagger UI: http://localhost:3001/)
- Postgres → `localhost:5432` (user/pass: `postgres`/`postgres`, db: `ngomongo`)
- Redis → `localhost:6379`

`docker-compose.yml` punya service `migrate` one-shot yang menjalankan `npx prisma migrate deploy` sekali sebelum backend start (meniru `preDeployCommand` Railway).

### Login WhatsApp di WAHA lokal

```bash
curl -X POST "http://localhost:3001/api/sessions" \
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

# Ambil QR
curl "http://localhost:3001/api/default/auth/qr?format=image" \
  -H "X-Api-Key: $WAHA_API_KEY" -o qr.png && open qr.png
```

### Development mode (backend tanpa Docker)

```bash
# Jalankan dependency saja
docker compose up -d postgres redis waha

npm install
npx prisma migrate dev   # buat schema & migration di DB dev
npm run dev              # hot-reload via tsx
```

Pastikan `.env` lokal punya:
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ngomongo?schema=public
REDIS_URL=redis://localhost:6379
WAHA_URL=http://localhost:3001
```

---

## 4. Memakai dashboard admin

Buka `https://<backend-domain>/dashboard/`, login dengan kredensial admin.

### Langkah pertama setelah deploy

1. **AI Provider** — tambah minimal 1 provider, isi API key, centang **Aktifkan sekarang**.

   Contoh konfigurasi yang umum:
   | Provider   | Model contoh                                |
   | ---------- | ------------------------------------------- |
   | `google`   | `gemini-2.0-flash`, `gemini-2.5-flash`      |
   | `openai`   | `gpt-4o-mini`, `gpt-4.1-mini`               |
   | `deepseek` | `deepseek-chat`, `deepseek-reasoner`        |
   | `groq`     | `llama-3.3-70b-versatile`, `openai/gpt-oss-20b` |

2. **Role AI** — buat 1 role dan tandai **default global**. Contoh:
   ```
   Kamu adalah asisten WhatsApp yang ramah. Jawab dalam Bahasa Indonesia,
   ringkas (maks 2 paragraf), dan WAJIB meniru style bahasa lawan bicara
   (formal/informal, singkatan, emoji) sesuai konteks yang diberikan.
   ```
3. **Whitelist Nomor** — tambah nomor (format internasional tanpa `+`, mis. `6281234567890`).
4. Kirim pesan dari nomor tersebut → bot membalas.

### Fitur upload export chat WhatsApp

**Dapatkan file export dari HP:**

1. Buka WhatsApp HP → buka chat dengan kontak target.
2. Titik tiga → **More → Export chat → Without media**.
3. Bagikan file `.txt` (atau `.zip` berisi `.txt`) ke email / cloud → pindahkan ke komputer.

**Upload via dashboard:**

1. Dashboard → tab **Whitelist Nomor**.
2. Pada baris nomor target → klik **Upload Export** → pilih file `.txt`/`.zip`.
3. Sistem akan:
   - Parse semua baris pesan format `[DD/MM/YY, HH:MM:SS] Nama: isi`
   - Kirim sample ke AI provider aktif untuk ekstraksi
   - Simpan `initial_summary` (KONTEKS + STYLE BAHASA) di tabel `memory_snapshots`
4. Status **Initial Summary** berubah ke `siap` (hijau).
5. Setiap pesan baru dari nomor itu akan memakai summary ini — AI meniru style bahasa.

Jika hanya punya teks deskripsi (tanpa file export), isi **Konteks Awal (teks manual)** lalu klik **Bangun dari Teks**.

### Ganti AI provider tanpa redeploy

Tab **AI Provider** → klik **Aktifkan** pada provider lain. Cache di-invalidate, request berikutnya pakai provider baru.

### Ganti kepribadian AI per nomor

Tab **Whitelist Nomor** → **Edit** pada baris nomor → ubah Role ID. Kosong = pakai default global.

### Lihat riwayat chat

Tab **Riwayat Chat** → pilih nomor → opsional filter tanggal → **Tampilkan**.

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
  schema.prisma
  migrations/         — SQL migrations
Dockerfile            — multi-stage build, Node 24 Alpine
railway.toml          — preDeployCommand untuk migrasi, healthcheck 300s
docker-compose.yml    — Postgres + Redis + WAHA + migrate (one-shot) + backend
.env.example
.npmrc                — legacy-peer-deps (kebutuhan LangChain ecosystem)
```

---

## Catatan keamanan

- Pakai `ADMIN_PASSWORD` yang kuat — basic auth adalah satu-satunya proteksi dashboard.
- Jangan commit `.env`. Pakai tab Variables di Railway.
- `WAHA_API_KEY` melindungi service WAHA dari akses publik — set value acak panjang.
- API keys provider AI disimpan di DB. Rotate via dashboard kapan saja.

## Troubleshooting

### Deploy Railway gagal di healthcheck
- Pastikan `railway.toml` punya `preDeployCommand = ["npx prisma migrate deploy"]` dan `healthcheckTimeout = 300`.
- Pastikan `Dockerfile` `CMD` hanya `["node","dist/server.js"]` (TIDAK ada `prisma migrate deploy` di sini).
- Lihat **Deploy Logs** Railway — log boot `[boot] ngomongo starting · node v24.x ...` harus muncul cepat.

### Backend tidak balas pesan
- Cek log Railway backend — apakah request ke `/webhook` masuk?
- Pastikan nomor sudah di-whitelist di dashboard (case-insensitive normalization: digit only).
- Pastikan minimal 1 provider AI berstatus `AKTIF`.

### WAHA tidak kirim webhook
- Swagger UI WAHA → `GET /api/sessions/default` → cek `config.webhooks[0].url` benar.
- Cek `WAHA_URL` di backend pakai URL **private** Railway (`*.railway.internal`).

### Migrasi Prisma error saat preDeploy
- Cek `DATABASE_URL` valid (sudah ter-reference dari service Postgres).
- Buka tab **Logs** service backend di section "Pre-deploy" → lihat error spesifik.
- Manual rerun: klik **⋯** pada deployment → **Redeploy**.

### `npm install` di lokal error peer dependency
- Sudah di-handle oleh `.npmrc` (`legacy-peer-deps=true`) karena ekosistem LangChain.js belum sepenuhnya rapi soal peerDeps.
