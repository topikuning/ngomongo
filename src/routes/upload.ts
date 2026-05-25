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
    try {
      const summary = await summarizeChatExport(
        parsed,
        entry.waNumber,
        aiSenderName,
        entry.initialContext || undefined,
      );
      await setInitialSummary(entry.waNumber, summary);
      await redis.del(`export:preview:${previewId}`);
      return { ok: true, messageCount: parsed.length, summary, aiSenderName };
    } catch (err) {
      app.log.error({ err }, "gagal menghasilkan initial summary");
      return reply
        .code(500)
        .send({ error: "gagal menghasilkan summary: " + (err as Error).message });
    }
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
