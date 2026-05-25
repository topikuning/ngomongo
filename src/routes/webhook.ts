import type { FastifyInstance, FastifyRequest } from "fastify";
import { isWhitelisted, ensureUser, getEffectiveSystemPrompt, normalizeNumber } from "../services/whitelist.js";
import { getMemory, appendAndMaybeSummarize, buildMessagesForLLM } from "../services/memory.js";
import { getActiveChatModel } from "../services/ai-router.js";
import { sendText } from "../services/waha-client.js";

interface WahaPayload {
  event?: string;
  session?: string;
  payload?: {
    id?: string;
    from?: string;
    fromMe?: boolean;
    body?: string;
    hasMedia?: boolean;
    _data?: { notifyName?: string };
  };
}

function extractMessage(body: unknown): {
  from: string | null;
  text: string;
  fromMe: boolean;
  notifyName?: string;
} {
  const b = body as WahaPayload;
  const payload = b.payload || {};
  const from = payload.from || null;
  const text = payload.body || "";
  const fromMe = !!payload.fromMe;
  const notifyName = payload._data?.notifyName;
  return { from, text, fromMe, notifyName };
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post("/webhook", async (req: FastifyRequest, reply) => {
    const { from, text, fromMe, notifyName } = extractMessage(req.body);

    // Diam total jika bukan pesan masuk valid atau pesan dari diri sendiri
    if (!from || !text || fromMe) {
      return reply.code(200).send({ ok: true });
    }

    // Hanya proses chat personal (@c.us). Abaikan group (@g.us) dan status.
    if (!from.endsWith("@c.us")) {
      return reply.code(200).send({ ok: true });
    }

    const waNumber = normalizeNumber(from);

    // Cek whitelist — jika tidak ada, diam total
    const allowed = await isWhitelisted(waNumber);
    if (!allowed) {
      return reply.code(200).send({ ok: true });
    }

    // Pastikan user terdaftar
    await ensureUser(waNumber, notifyName);

    try {
      const [systemPrompt, memory, model] = await Promise.all([
        getEffectiveSystemPrompt(waNumber),
        getMemory(waNumber),
        getActiveChatModel(),
      ]);

      const messages = buildMessagesForLLM(systemPrompt, memory, text);
      const res = await model.invoke(messages);
      const reply_text =
        (typeof res.content === "string" ? res.content : JSON.stringify(res.content)).trim() ||
        "(maaf, saya tidak bisa membalas saat ini)";

      await sendText(waNumber, reply_text);
      await appendAndMaybeSummarize(waNumber, text, reply_text);
    } catch (err) {
      app.log.error({ err }, "gagal memproses pesan masuk");
    }

    return reply.code(200).send({ ok: true });
  });
}
