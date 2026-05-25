import type { FastifyInstance, FastifyRequest } from "fastify";
import { isWhitelisted, ensureUser, getEffectiveSystemPrompt, normalizeNumber } from "../services/whitelist.js";
import { getMemory, appendAndMaybeSummarize, buildMessagesForLLM } from "../services/memory.js";
import { getChatModelForNumber } from "../services/ai-router.js";
import { sendText, resolveLidToPhone } from "../services/waha-client.js";
import { recordWebhookEvent } from "../services/webhook-log.js";

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
  return { event, from: fromStr, realPhoneJid, text, fromMe, notifyName };
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
    const { event, from, realPhoneJid, text, fromMe, notifyName } = extracted;

    const record = (decision: string) =>
      recordWebhookEvent({ remoteIp, decision, extracted, raw: req.body });

    // Kalau event-nya bukan pesan baru (mis. message.ack, presence.update,
    // group.v2.join), lewati senyap. Ini menjelaskan banyak entri "from
    // tidak ditemukan" yang sebelumnya bikin log penuh.
    if (event && !MESSAGE_EVENTS.has(event)) {
      record(`skip: event=${event} (bukan pesan masuk baru)`);
      return reply.code(200).send({ ok: true });
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
