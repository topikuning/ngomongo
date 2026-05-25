import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { normalizeNumber } from "../services/whitelist.js";
import {
  extractTextFromBuffer,
  parseWhatsAppExport,
  summarizeChatExport,
  buildInitialSummaryFromText,
} from "../services/chat-parser.js";
import { setInitialSummary } from "../services/memory.js";

export async function uploadRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/api/whitelist/:id/upload-export",
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

      try {
        const summary = await summarizeChatExport(
          parsed,
          entry.displayName || undefined,
          entry.initialContext || undefined,
        );
        await setInitialSummary(entry.waNumber, summary);
        return { ok: true, messageCount: parsed.length, summary };
      } catch (err) {
        app.log.error({ err }, "gagal menghasilkan initial summary");
        return reply
          .code(500)
          .send({ error: "gagal menghasilkan summary: " + (err as Error).message });
      }
    },
  );

  // Bangun initial summary HANYA dari teks manual (tanpa upload file)
  app.post<{ Params: { id: string } }>(
    "/api/whitelist/:id/build-summary-from-text",
    async (req, reply) => {
      const id = Number(req.params.id);
      const entry = await prisma.whitelistedNumber.findUnique({ where: { id } });
      if (!entry) return reply.code(404).send({ error: "nomor tidak ditemukan" });
      if (!entry.initialContext) {
        return reply.code(400).send({ error: "initialContext kosong" });
      }
      try {
        const summary = await buildInitialSummaryFromText(entry.initialContext);
        await setInitialSummary(entry.waNumber, summary);
        return { ok: true, summary };
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    },
  );
}
