import type { FastifyInstance, FastifyRequest } from "fastify";
import { isWhitelisted, ensureUser, getEffectiveSystemPrompt, normalizeNumber } from "../services/whitelist.js";
import { getMemory, appendAndMaybeSummarize, buildMessagesForLLM } from "../services/memory.js";
import { getChatModelForNumber } from "../services/ai-router.js";
import { sendText, resolveLidToPhone } from "../services/waha-client.js";
import { recordWebhookEvent } from "../services/webhook-log.js";
import { redis } from "../lib/redis.js";

type AnyObj = Record<string, unknown>;
function obj(v: unknown): AnyObj { return (v && typeof v === "object") ? v as AnyObj : {}; }
function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function bool(v: unknown): boolean { return v === true; }

const PERSONAL_SUFFIXES = ["@c.us", "@s.whatsapp.net", "@lid"];

function isPersonalChat(jid: string): boolean {
  return PERSONAL_SUFFIXES.some((s) => jid.endsWith(s));
}

const PHONE_JID_RE = /^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/;

// Cari nomor telepon asli sender di PAYLOAD WAHA tanpa hit API.
//
// WhatsApp protocol baru menggunakan @lid (Linked IDentifier) — angka
// sintetik yang menyembunyikan nomor telepon di grup publik / scenario
// privacy lain. Untuk matching ke whitelist user butuh nomor asli.
//
// WAHA belum menyediakan field uniform `pnJid` (lihat feature request
// devlikeapro/waha#993). Untuk sekarang, sumber nomor asli yang
// tersedia di payload tergantung engine:
//
//   - NOWEB (baileys, default WAHA CORE):
//       payload._data.key.remoteJidAlt = "62xxx@s.whatsapp.net"
//     Dikonfirmasi sebagai workaround standar oleh maintainer & user
//     di issue devlikeapro/waha#1608 dan #2010.
//
//   - WEBJS (WhatsApp Web): payload._data.id.remote
//
// TIDAK pakai scan rekursif terhadap seluruh body, karena top-level
// `me` berisi nomor BOT sendiri ("me.id":"<botnumber>@c.us") yang
// akan salah-pilih kalau di-scan tanpa konteks. Cari di path spesifik
// dulu; fallback scan HANYA terhadap subtree `payload`.
//
// Field ini tidak selalu ada (mis. message.reaction events per
// issue #2010). Untuk kasus itu kita pakai resolveLidToPhone() yang
// hit endpoint resmi GET /api/{session}/lids/{lid}.
function extractRealSenderPhoneJid(body: AnyObj): string | null {
  const payload = obj(body.payload ?? body.data ?? body);
  const data = obj(payload._data);
  const key = obj(data.key);

  // NOWEB: remoteJidAlt = nomor asli kalau remoteJid berupa @lid
  const noweb = str(key.remoteJidAlt);
  if (noweb && PHONE_JID_RE.test(noweb)) return noweb;

  // NOWEB: kalau remoteJid sendiri sudah nomor (bukan @lid), pakai itu
  const remoteJid = str(key.remoteJid);
  if (remoteJid && PHONE_JID_RE.test(remoteJid)) return remoteJid;

  // WEBJS: _data.id.remote
  const webjsRemote = str(obj(data.id).remote);
  if (webjsRemote && PHONE_JID_RE.test(webjsRemote)) return webjsRemote;

  // Fallback: scan HANYA payload (tidak termasuk `me` di top-level).
  const seen = new WeakSet<object>();
  function scan(o: unknown, depth: number): string | null {
    if (depth > 6) return null;
    if (typeof o === "string") {
      return PHONE_JID_RE.test(o) ? o : null;
    }
    if (o && typeof o === "object") {
      if (seen.has(o)) return null;
      seen.add(o);
      for (const v of Object.values(o as AnyObj)) {
        const r = scan(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  return scan(payload, 0);
}

// Extractor permisif. WAHA punya beberapa format payload tergantung
// versi/engine; coba beberapa path yang umum:
//   - WAHA Core   : { event, session, payload: { from, body, fromMe, ... } }
//   - WAHA Plus   : { event, session, payload: { from: { id }, body, fromMe } }
//   - Beberapa engine pakai `data` alih-alih `payload`, atau menaruh
//     pesan langsung di top-level.
function extractMessage(body: unknown): {
  event: string | null;
  messageId: string | null;
  from: string | null;        // JID asli yang dilaporkan WAHA (mungkin @lid)
  realPhoneJid: string | null; // JID nomor telepon asli kalau bisa diekstrak
  text: string;
  fromMe: boolean;
  notifyName?: string;
} {
  const b = obj(body);
  const event = str(b.event) ?? str(b.type) ?? null;
  const p = obj(b.payload ?? b.data ?? b);
  const data = obj(p._data);
  const fromField = p.from;
  // Message ID unik per pesan WhatsApp — sama di event `message` dan
  // `message.any`. Ini kunci untuk dedup.
  const messageId =
    str(p.id) ??
    str(obj(data.key).id) ??
    null;
  const fromStr =
    str(fromField) ??
    str(obj(fromField).id) ??
    str(p.chatId) ??
    str(obj(p.chat).id) ??
    str(obj(data.key).remoteJid) ??
    null;
  const text =
    str(p.body) ??
    str(p.text) ??
    str(obj(p.message).body) ??
    str(obj(data.message).conversation) ??
    str(obj(obj(data.message).extendedTextMessage).text) ??
    "";
  const fromMe =
    bool(p.fromMe) || bool(obj(p.message).fromMe) || bool(obj(data.key).fromMe);
  const notifyName =
    str(data.pushName) ??
    str(obj(data).notifyName) ??
    str(p.notifyName) ??
    str(obj(fromField).name);
  const realPhoneJid = extractRealSenderPhoneJid(b);
  return { event, messageId, from: fromStr, realPhoneJid, text, fromMe, notifyName };
}

// Dedup berbasis Redis SETNX. Setiap msg.id WhatsApp diberi flag
// dengan TTL 5 menit; event kedua dengan id sama akan kalah race dan
// di-skip. Ini perlu karena WAHA mengirim BANYAK event untuk pesan
// yang sama tergantung WHATSAPP_HOOK_EVENTS user:
//   - "message"     → pesan baru
//   - "message.any" → SEMUA pesan (termasuk yang sama dengan di atas)
//   - "messages.upsert" (baileys-style)
// Daripada minta user merapikan config WAHA, dedup di sisi kita lebih
// robust. TTL 5 menit cukup karena duplikat datang dalam hitungan ms.
const DEDUP_TTL_SECONDS = 300;

async function claimMessage(messageId: string): Promise<boolean> {
  try {
    const r = await redis.set(`processed:msg:${messageId}`, "1", "EX", DEDUP_TTL_SECONDS, "NX");
    return r === "OK";
  } catch {
    // Kalau Redis down, lebih baik biarkan pesan lewat (false-positive
    // jawab dua kali) daripada drop semua pesan.
    return true;
  }
}

// Lapisan dedup KEDUA berbasis konten (sender + text). Jaring pengaman
// untuk kasus dimana msg.id antar event ternyata berbeda (mis. WAHA
// engine berbeda menghasilkan id berbeda untuk pesan yang sama).
// TTL pendek (5 detik) supaya tidak false-positive untuk user yang
// memang sengaja mengirim pesan sama dua kali. 5 detik cukup karena
// duplikat dari WAHA tiba dalam hitungan milidetik.
const CONTENT_DEDUP_TTL_SECONDS = 5;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

async function claimByContent(sender: string, text: string): Promise<boolean> {
  const key = `processed:content:${sender}:${fnv1a(text)}`;
  try {
    const r = await redis.set(key, "1", "EX", CONTENT_DEDUP_TTL_SECONDS, "NX");
    return r === "OK";
  } catch {
    return true;
  }
}

// Daftar event WAHA yang kita anggap "pesan masuk yang perlu dijawab".
// Selain ini (mis. message.ack, presence.update, group.v2.*, dst) di-skip
// senyap dengan label event-nya supaya log tidak penuh dengan noise.
const MESSAGE_EVENTS = new Set([
  "message",
  "message.any",
  "messages.upsert", // baileys-style
]);

export async function webhookRoutes(app: FastifyInstance) {
  app.post("/webhook", async (req: FastifyRequest, reply) => {
    const remoteIp = req.ip;
    const extracted = extractMessage(req.body);
    const { event, messageId, from, realPhoneJid, text, fromMe, notifyName } = extracted;

    const record = (decision: string) =>
      recordWebhookEvent({ remoteIp, decision, extracted, raw: req.body });

    // Kalau event-nya bukan pesan baru (mis. message.ack, presence.update,
    // group.v2.join), lewati senyap. Ini menjelaskan banyak entri "from
    // tidak ditemukan" yang sebelumnya bikin log penuh.
    if (event && !MESSAGE_EVENTS.has(event)) {
      record(`skip: event=${event} (bukan pesan masuk baru)`);
      return reply.code(200).send({ ok: true });
    }

    // Dedup berdasarkan message.id. Tanpa ini, WAHA yang mengirim
    // `message` DAN `message.any` untuk pesan yang sama akan bikin bot
    // membalas dua kali (atau lebih).
    if (messageId) {
      const fresh = await claimMessage(messageId);
      if (!fresh) {
        record(`skip: duplikat (msg.id=${messageId} sudah diproses ≤${DEDUP_TTL_SECONDS}s lalu — WAHA mengirim event yang sama dua kali, biasanya kombinasi 'message' + 'message.any')`);
        return reply.code(200).send({ ok: true });
      }
    }

    if (fromMe) {
      record("skip: fromMe=true (pesan terkirim dari nomor bot)");
      return reply.code(200).send({ ok: true });
    }
    if (!from && !realPhoneJid) {
      record(`skip: field 'from' tidak ditemukan di payload${event ? ` (event=${event})` : ""}`);
      return reply.code(200).send({ ok: true });
    }
    if (!text) {
      record("skip: field 'body'/'text' kosong (kemungkinan media/sticker)");
      return reply.code(200).send({ ok: true });
    }

    // Tolak chat grup (@g.us, @broadcast). LID dan c.us/s.whatsapp.net diterima.
    const incomingJid = from || realPhoneJid || "";
    if (!isPersonalChat(incomingJid) && !realPhoneJid) {
      record(`skip: bukan chat personal (from=${incomingJid})`);
      return reply.code(200).send({ ok: true });
    }

    // Resolusi nomor telepon untuk whitelist matching:
    //   1) realPhoneJid dari payload (no network call) — paling cepat
    //   2) Fallback: hit endpoint resmi WAHA GET /api/{session}/lids/{lid}
    //      kalau `from` adalah @lid dan tidak ada di payload (cached 24h)
    //   3) Last resort: pakai digit @lid apa adanya, beri petunjuk ke user
    //      supaya bisa whitelist LID sebagai fallback
    let canonicalJid = realPhoneJid || incomingJid;
    let lookupSource = realPhoneJid ? "payload._data.key.remoteJidAlt" : "from";
    if (!realPhoneJid && incomingJid.endsWith("@lid")) {
      const resolved = await resolveLidToPhone(incomingJid);
      if (resolved) {
        canonicalJid = resolved;
        lookupSource = "GET /api/{session}/lids/{lid}";
      }
    }
    const waNumber = normalizeNumber(canonicalJid);

    if (!waNumber) {
      record(`skip: tidak bisa mendapatkan nomor dari ${incomingJid}`);
      return reply.code(200).send({ ok: true });
    }

    // Dedup lapis kedua: kalau msg.id berbeda antar event tapi sender+text
    // identik dalam 5 detik, anggap duplikat. Jaring pengaman untuk
    // kasus dedup-by-id meleset.
    const contentFresh = await claimByContent(waNumber, text);
    if (!contentFresh) {
      record(`skip: duplikat konten (sender=${waNumber}, text identik dalam ${CONTENT_DEDUP_TTL_SECONDS}s terakhir — fallback dedup)`);
      return reply.code(200).send({ ok: true });
    }

    // Cek whitelist — jika tidak ada, diam total
    const allowed = await isWhitelisted(waNumber);
    if (!allowed) {
      const hint =
        canonicalJid !== incomingJid
          ? ` (resolusi dari ${incomingJid} via ${lookupSource})`
          : incomingJid.endsWith("@lid")
          ? ` (resolusi LID gagal — payload tidak ada remoteJidAlt DAN GET /api/{session}/lids/{lid} tidak mengembalikan pn. Tambahkan ID '${waNumber}' ke whitelist sebagai fallback)`
          : "";
      record(`skip: nomor ${waNumber} tidak ada di whitelist atau dinonaktifkan${hint}`);
      return reply.code(200).send({ ok: true });
    }

    // Pastikan user terdaftar
    await ensureUser(waNumber, notifyName);

    try {
      const [systemPrompt, memory, model] = await Promise.all([
        getEffectiveSystemPrompt(waNumber),
        getMemory(waNumber),
        getChatModelForNumber(waNumber),
      ]);

      const messages = buildMessagesForLLM(systemPrompt, memory, text);
      const res = await model.invoke(messages);
      const reply_text =
        (typeof res.content === "string" ? res.content : JSON.stringify(res.content)).trim() ||
        "(maaf, saya tidak bisa membalas saat ini)";

      // Untuk sendText, prioritaskan nomor telepon hasil resolusi
      // (sendText kalau dikirim ke @lid kadang gagal di NOWEB; @c.us
      // / @s.whatsapp.net selalu berhasil).
      await sendText(waNumber, reply_text);
      await appendAndMaybeSummarize(waNumber, text, reply_text);
      record(`processed: balas ke ${waNumber} (${reply_text.length} char)`);
    } catch (err) {
      const msg = (err as Error).message;
      app.log.error({ err }, "gagal memproses pesan masuk");
      record(`error: ${msg}`);
    }

    return reply.code(200).send({ ok: true });
  });
}
