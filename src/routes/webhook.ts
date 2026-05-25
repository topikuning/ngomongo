import type { FastifyInstance, FastifyRequest } from "fastify";
import { isWhitelisted, ensureUser, getEffectiveSystemPrompt, normalizeNumber } from "../services/whitelist.js";
import { getMemory, appendAndMaybeSummarize, buildMessagesForLLM } from "../services/memory.js";
import { getChatModelForNumber } from "../services/ai-router.js";
import { sendText } from "../services/waha-client.js";
import { recordWebhookEvent } from "../services/webhook-log.js";

type AnyObj = Record<string, unknown>;
function obj(v: unknown): AnyObj { return (v && typeof v === "object") ? v as AnyObj : {}; }
function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function bool(v: unknown): boolean { return v === true; }

const PERSONAL_SUFFIXES = ["@c.us", "@s.whatsapp.net", "@lid"];

function isPersonalChat(jid: string): boolean {
  return PERSONAL_SUFFIXES.some((s) => jid.endsWith(s));
}

// Cari string yang BENAR-BENAR nomor telepon (bukan LID) di mana saja
// di dalam payload. WhatsApp protocol baru sering pakai @lid (Linked
// IDentifier) yang BUKAN nomor telepon — angkanya sintetik. Untuk
// matching ke whitelist kita butuh nomor asli yang biasanya juga ada
// di field lain payload (mis. _data.id.remote, _data.Info.Sender,
// chatId, dst). Lakukan scan rekursif sederhana.
function findRealPhoneJid(root: unknown): string | null {
  const seen = new WeakSet<object>();
  function scan(o: unknown, depth: number): string | null {
    if (depth > 6) return null;
    if (typeof o === "string") {
      const m = o.match(/^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/);
      return m ? o : null;
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
  return scan(root, 0);
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
  const fromField = p.from;
  const fromStr =
    str(fromField) ??
    str(obj(fromField).id) ??
    str(p.chatId) ??
    str(obj(p.chat).id) ??
    null;
  const text =
    str(p.body) ??
    str(p.text) ??
    str(obj(p.message).body) ??
    "";
  const fromMe =
    bool(p.fromMe) || bool(obj(p.message).fromMe);
  const notifyName =
    str(obj(p._data).notifyName) ??
    str(p.notifyName) ??
    str(obj(fromField).name);
  const realPhoneJid = findRealPhoneJid(body);
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

    // Untuk whitelist matching, prioritaskan nomor telepon asli (@c.us /
    // @s.whatsapp.net) yang sering tetap ada di payload meskipun field
    // `from` utama berupa @lid. Kalau benar-benar cuma ada @lid, pakai
    // digit @lid apa adanya — user bisa tambahkan ID itu ke whitelist
    // sebagai fallback.
    const canonicalJid = realPhoneJid || incomingJid;
    const waNumber = normalizeNumber(canonicalJid);

    if (!waNumber) {
      record(`skip: tidak bisa mendapatkan nomor dari ${incomingJid}`);
      return reply.code(200).send({ ok: true });
    }

    // Cek whitelist — jika tidak ada, diam total
    const allowed = await isWhitelisted(waNumber);
    if (!allowed) {
      const hint = realPhoneJid
        ? ` (dideteksi dari ${realPhoneJid}, asli=${incomingJid})`
        : incomingJid.endsWith("@lid")
        ? ` (hanya @lid yang dikirim WAHA, tidak ada nomor telepon asli di payload — tambahkan ID '${waNumber}' ke whitelist sebagai fallback)`
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

      // Untuk sendText, prioritaskan nomor telepon asli (sendText kalau
      // dikirim ke @lid kadang gagal di WAHA).
      const sendTarget = realPhoneJid ? normalizeNumber(realPhoneJid) : waNumber;
      await sendText(sendTarget, reply_text);
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
