import { request } from "undici";
import { redis } from "../lib/redis.js";

const WAHA_URL = (process.env.WAHA_URL || "http://localhost:3001").replace(/\/$/, "");
const WAHA_API_KEY = process.env.WAHA_API_KEY || "";
const WAHA_SESSION = process.env.WAHA_SESSION || "default";

function buildHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (WAHA_API_KEY) h["X-Api-Key"] = WAHA_API_KEY;
  return h;
}

function toChatId(waNumber: string): string {
  const n = waNumber.replace(/@.*/g, "").replace(/\D/g, "");
  return `${n}@c.us`;
}

export async function sendText(waNumber: string, text: string): Promise<void> {
  const url = `${WAHA_URL}/api/sendText`;
  const body = {
    session: WAHA_SESSION,
    chatId: toChatId(waNumber),
    text,
  };

  const res = await request(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  if (res.statusCode >= 400) {
    const txt = await res.body.text();
    throw new Error(`WAHA sendText gagal (${res.statusCode}): ${txt}`);
  } else {
    await res.body.dump();
  }
}

export interface WahaSessionInfo {
  ok: boolean;
  status: number;
  sessionStatus?: string; // WORKING, SCAN_QR_CODE, FAILED, dst.
  sessionName?: string;
  url: string;
  raw?: unknown;
  error?: string;
}

export async function pingWahaSession(): Promise<WahaSessionInfo> {
  const url = `${WAHA_URL}/api/sessions/${encodeURIComponent(WAHA_SESSION)}`;
  try {
    const res = await request(url, { method: "GET", headers: buildHeaders() });
    const txt = await res.body.text();
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(txt); } catch { /* non-json */ }
    if (res.statusCode >= 400) {
      return { ok: false, status: res.statusCode, url, error: txt.slice(0, 500), raw: parsed };
    }
    const p = parsed as { status?: string; name?: string } | undefined;
    return {
      ok: true,
      status: res.statusCode,
      sessionStatus: p?.status,
      sessionName: p?.name,
      url,
      raw: parsed,
    };
  } catch (err) {
    return { ok: false, status: 0, url, error: (err as Error).message };
  }
}

/**
 * Resolusi LID (Linked IDentifier) → nomor telepon via WAHA Contacts API.
 *
 * Dipakai sebagai FALLBACK ketika field webhook (payload._data.key.remoteJidAlt)
 * tidak menyediakan nomor telepon — kasus yang didokumentasikan terjadi pada:
 *   - message.reaction events (lihat issue #2010)
 *   - WAHA versi lama / engine tertentu
 *   - kontak yang belum pernah disinkronkan
 *
 * Endpoint resmi: GET /api/{session}/lids/{lid}
 * Response       : { "lid": "...@lid", "pn": "...@c.us" } atau { "pn": null }
 *
 * Hasil di-cache di Redis 24 jam (rekomendasi komunitas di discussion #1858)
 * supaya tidak hit WAHA API tiap pesan. Cache key juga mencatat "tidak ada
 * mapping" (nilai string "null") supaya kita tidak retry terus-menerus.
 *
 * Docs / sources:
 *   - https://github.com/devlikeapro/waha/issues/993   (feature request pnJid)
 *   - https://github.com/devlikeapro/waha/issues/1608  (payload.from = @lid bug)
 *   - https://github.com/devlikeapro/waha/issues/2010  (remoteJidAlt missing)
 *   - https://github.com/devlikeapro/waha/discussions/1858 (community pattern)
 */
const LID_CACHE_PREFIX = "waha:lid:";
const LID_CACHE_TTL_SECONDS = 24 * 3600;

export async function resolveLidToPhone(lidJid: string): Promise<string | null> {
  if (!lidJid.endsWith("@lid")) return null;

  const cacheKey = LID_CACHE_PREFIX + lidJid;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return cached === "__null__" ? null : cached;
  } catch {
    // Redis down — lanjut tanpa cache
  }

  const url = `${WAHA_URL}/api/${encodeURIComponent(WAHA_SESSION)}/lids/${encodeURIComponent(lidJid)}`;
  let pn: string | null = null;
  try {
    const res = await request(url, { method: "GET", headers: buildHeaders() });
    const txt = await res.body.text();
    if (res.statusCode === 200) {
      try {
        const j = JSON.parse(txt) as { pn?: string | null };
        pn = j.pn || null;
      } catch {
        pn = null;
      }
    }
    // 404 atau status lain: pn tetap null (di-cache sebagai null juga)
  } catch {
    return null; // network error — jangan cache, biar bisa retry kali berikutnya
  }

  try {
    await redis.set(cacheKey, pn ?? "__null__", "EX", LID_CACHE_TTL_SECONDS);
  } catch {
    // ignore cache write error
  }
  return pn;
}

export async function startTyping(waNumber: string): Promise<void> {
  try {
    await request(`${WAHA_URL}/api/startTyping`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        session: WAHA_SESSION,
        chatId: toChatId(waNumber),
      }),
    }).then((r) => r.body.dump());
  } catch {
    // typing indikator opsional — jangan throw
  }
}
