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

// Extractor permisif. WAHA punya beberapa format payload tergantung
// versi/engine; coba beberapa path yang umum:
//   - WAHA Core   : { event, session, payload: { from, body, fromMe, ... } }
//   - WAHA Plus   : { event, session, payload: { from: { id }, body, fromMe } }
//   - Beberapa engine pakai `data` alih-alih `payload`, atau menaruh
//     pesan langsung di top-level.
function extractMessage(body: unknown): {
  from: string | null;
  text: string;
  fromMe: boolean;
  notifyName?: string;
} {
  const b = obj(body);
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
  return { from: fromStr, text, fromMe, notifyName };
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post("/webhook", async (req: FastifyRequest, reply) => {
    const remoteIp = req.ip;
    const extracted = extractMessage(req.body);
    const { from, text, fromMe, notifyName } = extracted;

    const record = (decision: string) =>
      recordWebhookEvent({ remoteIp, decision, extracted, raw: req.body });

    // Diam total jika bukan pesan masuk valid atau pesan dari diri sendiri
    if (fromMe) {
      record("skip: fromMe=true (pesan terkirim dari nomor bot)");
      return reply.code(200).send({ ok: true });
    }
    if (!from) {
      record("skip: field `from` tidak ditemukan di payload");
      return reply.code(200).send({ ok: true });
    }
    if (!text) {
      record("skip: field `body`/`text` kosong (kemungkinan media/sticker)");
      return reply.code(200).send({ ok: true });
    }

    // Hanya proses chat personal (@c.us). Abaikan group (@g.us) dan status.
    if (!from.endsWith("@c.us")) {
      record(`skip: bukan chat personal (from=${from})`);
      return reply.code(200).send({ ok: true });
    }

    const waNumber = normalizeNumber(from);

    // Cek whitelist — jika tidak ada, diam total
    const allowed = await isWhitelisted(waNumber);
    if (!allowed) {
      record(`skip: nomor ${waNumber} tidak ada di whitelist atau dinonaktifkan`);
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
