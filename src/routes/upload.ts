import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import {
  extractTextFromBuffer,
  parseWhatsAppExport,
  analyzeSenders,
  summarizeChatExport,
  buildInitialSummaryFromText,
} from "../services/chat-parser.js";
import { setInitialSummary } from "../services/memory.js";

// TTL preview: 10 menit. Cukup waktu untuk user memilih peran AI di
// modal tanpa harus re-upload file kalau ragu sebentar.
const PREVIEW_TTL_SECONDS = 600;

export async function uploadRoutes(app: FastifyInstance) {
  /**
   * STEP 1 — Upload file, parse, analisis partisipan.
   * Tidak memanggil LLM sama sekali (cepat).
   * Simpan raw text di Redis dengan previewId supaya step 2 tidak
   * perlu upload ulang.
   */
  app.post<{ Params: { id: string } }>(
    "/api/whitelist/:id/preview-export",
    async (req, reply) => {
      const id = Number(req.params.id);
      const entry = await prisma.whitelistedNumber.findUnique({ where: { id } });
      if (!entry) return reply.code(404).send({ error: "nomor tidak ditemukan" });

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "file wajib diupload" });

      const buf = await file.toBuffer();
      let raw: string;
      try {
        raw = extractTextFromBuffer(buf, file.filename);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const parsed = parseWhatsAppExport(raw);
      if (parsed.length === 0) {
        return reply
          .code(400)
          .send({ error: "Tidak ada pesan yang bisa diparse dari file ini" });
      }
      const senders = analyzeSenders(parsed);
      if (senders.length < 2) {
        return reply.code(400).send({
          error: `Chat ini hanya berisi 1 partisipan (${senders[0]?.sender || "?"}). Perlu minimal 2 untuk menentukan peran AI.`,
        });
      }

      const previewId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await redis.set(`export:preview:${previewId}`, raw, "EX", PREVIEW_TTL_SECONDS);

      return {
        previewId,
        totalMessages: parsed.length,
        senders,
        expiresInSeconds: PREVIEW_TTL_SECONDS,
      };
    },
  );

  /**
   * STEP 2 — Setelah user pilih peran AI di modal, panggil ini dengan
   * previewId + aiSenderName. Generate structured summary.
   */
  app.post<{
    Params: { id: string };
    Body: { previewId: string; aiSenderName: string };
  }>("/api/whitelist/:id/build-summary-from-export", async (req, reply) => {
    const id = Number(req.params.id);
    const entry = await prisma.whitelistedNumber.findUnique({ where: { id } });
    if (!entry) return reply.code(404).send({ error: "nomor tidak ditemukan" });

    const { previewId, aiSenderName } = req.body || ({} as { previewId?: string; aiSenderName?: string });
    if (!previewId || !aiSenderName) {
      return reply.code(400).send({ error: "previewId dan aiSenderName wajib diisi" });
    }

    const raw = await redis.get(`export:preview:${previewId}`);
    if (!raw) {
      return reply.code(400).send({
        error: "Preview kadaluarsa (>10 menit) atau previewId tidak valid. Upload ulang file-nya.",
      });
    }

    const parsed = parseWhatsAppExport(raw);
    // Pola error context-window dari berbagai provider:
    //   OpenAI    : "This model's maximum context length is X tokens.
    //               However, your messages resulted in Y tokens.
    //               Please reduce the length of the messages..."
    //   Mistral   : "messages tokens exceeds the maximum context length..."
    //   Groq      : "Please reduce the length of the messages..."
    //   Anthropic : "max_tokens" / "input is too long"
    //   Google    : "exceeds the context window limit"
    const isContextErr = (msg: string) =>
      /(reduce the length|exceeds (the )?(maximum |context )?context|context length|input is too long|too many tokens|maximum.*tokens|400|context window)/i.test(
        msg,
      );

    const tryGenerate = async (maxChars?: number) => {
      return summarizeChatExport(
        parsed,
        entry.waNumber,
        aiSenderName,
        entry.initialContext || undefined,
        maxChars ? { maxChars } : undefined,
      );
    };

    let summary: string;
    let sampled = false;
    let sampledNote = "";
    try {
      summary = await tryGenerate(); // default 1.2M chars
    } catch (err1) {
      const msg1 = (err1 as Error).message;
      if (!isContextErr(msg1)) {
        app.log.error({ err: err1 }, "gagal menghasilkan initial summary");
        return reply.code(500).send({
          error: "Gagal generate summary: " + msg1,
        });
      }
      // Auto-retry dengan sample lebih kecil.
      app.log.warn({ msg1 }, "context overflow, retry dengan 120K chars");
      try {
        summary = await tryGenerate(120_000);
        sampled = true;
        sampledNote =
          "Chat dipotong (start+middle+end) karena provider AI yang dipilih tidak muat menerima full chat. Untuk analisis penuh, pakai provider context besar: Gemini 2.5 Pro/Flash (1M), DeepSeek (128K), Mistral Large (128K), atau Groq Llama 3.3 70B (128K).";
      } catch (err2) {
        const msg2 = (err2 as Error).message;
        if (!isContextErr(msg2)) {
          return reply.code(500).send({
            error: "Gagal generate summary (retry kecil): " + msg2,
          });
        }
        // Retry terakhir dengan 30K chars (fit di semua model termasuk Mistral Medium)
        app.log.warn({ msg2 }, "masih overflow, retry final dengan 30K chars");
        try {
          summary = await tryGenerate(30_000);
          sampled = true;
          sampledNote =
            "Chat dipotong drastis (~7K token) karena provider AI yang dipilih punya context window kecil. Hasil analisis terbatas — pakai provider dengan context besar untuk hasil maksimal.";
        } catch (err3) {
          return reply.code(500).send({
            error:
              "Gagal generate summary bahkan dengan sample kecil: " +
              (err3 as Error).message,
          });
        }
      }
    }

    await setInitialSummary(entry.waNumber, summary);
    await redis.del(`export:preview:${previewId}`);
    return {
      ok: true,
      messageCount: parsed.length,
      summary,
      aiSenderName,
      sampled,
      sampledNote: sampled ? sampledNote : undefined,
    };
  });

  /**
   * Build summary HANYA dari teks manual di field initialContext.
   * Optional: aiPersonaName + humanName supaya structured summary
   * bisa mengunci peran walau tanpa upload file.
   */
  app.post<{
    Params: { id: string };
    Body?: { aiPersonaName?: string; humanName?: string };
  }>("/api/whitelist/:id/build-summary-from-text", async (req, reply) => {
    const id = Number(req.params.id);
    const entry = await prisma.whitelistedNumber.findUnique({ where: { id } });
    if (!entry) return reply.code(404).send({ error: "nomor tidak ditemukan" });
    if (!entry.initialContext) {
      return reply.code(400).send({ error: "initialContext kosong" });
    }
    const { aiPersonaName, humanName } = req.body || {};
    try {
      const summary = await buildInitialSummaryFromText(
        entry.initialContext,
        entry.waNumber,
        {
          aiPersonaName: aiPersonaName?.trim() || undefined,
          humanName: humanName?.trim() || entry.displayName || undefined,
        },
      );
      await setInitialSummary(entry.waNumber, summary);
      return { ok: true, summary };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
