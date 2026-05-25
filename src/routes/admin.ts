import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { invalidateProviderCache, testProvider } from "../services/ai-router.js";
import { normalizeNumber } from "../services/whitelist.js";
import { resetMemory } from "../services/memory.js";
import { getWebhookLog, clearWebhookLog } from "../services/webhook-log.js";
import { listPrompts, setPrompt, resetPrompt } from "../services/prompt-store.js";

export async function adminRoutes(app: FastifyInstance) {
  // ============ AI PROVIDERS ============
  app.get("/api/providers", async () => {
    return prisma.aiProvider.findMany({ orderBy: { priority: "desc" } });
  });

  app.post<{
    Body: {
      nama: string;
      provider: string;
      model: string;
      apiKey: string;
      priority?: number;
      isDefault?: boolean;
    };
  }>("/api/providers", async (req, reply) => {
    const { nama, provider, model, apiKey, priority, isDefault } = req.body;
    if (!nama || !provider || !model || !apiKey) {
      return reply.code(400).send({ error: "nama, provider, model, apiKey wajib diisi" });
    }
    if (!["google", "openai", "deepseek", "groq", "mistral"].includes(provider)) {
      return reply.code(400).send({ error: "provider harus google|openai|deepseek|groq|mistral" });
    }

    // Kalau belum ada provider lain sama sekali, paksa provider pertama ini jadi default.
    const existingCount = await prisma.aiProvider.count();
    const makeDefault = !!isDefault || existingCount === 0;

    const created = await prisma.aiProvider.create({
      data: {
        nama,
        provider,
        model,
        apiKey,
        priority: priority ?? 0,
        isDefault: makeDefault,
      },
    });
    if (makeDefault) {
      await prisma.aiProvider.updateMany({
        where: { id: { not: created.id } },
        data: { isDefault: false },
      });
    }
    invalidateProviderCache();
    return created;
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{
      nama: string;
      provider: string;
      model: string;
      apiKey: string;
      priority: number;
      isDefault: boolean;
    }>;
  }>("/api/providers/:id", async (req) => {
    const id = Number(req.params.id);
    const data: Record<string, unknown> = {};
    const b = req.body;
    if (b.nama !== undefined) data.nama = b.nama;
    if (b.provider !== undefined) data.provider = b.provider;
    if (b.model !== undefined) data.model = b.model;
    if (b.apiKey !== undefined && b.apiKey !== "") data.apiKey = b.apiKey;
    if (b.priority !== undefined) data.priority = b.priority;
    if (b.isDefault !== undefined) data.isDefault = b.isDefault;

    const updated = await prisma.aiProvider.update({ where: { id }, data });
    if (updated.isDefault) {
      await prisma.aiProvider.updateMany({
        where: { id: { not: id } },
        data: { isDefault: false },
      });
    }
    invalidateProviderCache();
    return updated;
  });

  // Tes satu provider tertentu (kirim prompt singkat "PONG"). Tidak
  // mengubah default. Bisa dipanggil per provider dari tab AI Provider.
  app.post<{ Params: { id: string } }>("/api/providers/:id/test", async (req, reply) => {
    const id = Number(req.params.id);
    const p = await prisma.aiProvider.findUnique({ where: { id } });
    if (!p) return reply.code(404).send({ error: "Provider tidak ditemukan" });
    const result = await testProvider(p);
    return {
      ...result,
      providerId: p.id,
      nama: p.nama,
      provider: p.provider,
      model: p.model,
    };
  });

  // Tandai provider ini sebagai default global. Semua provider lain
  // otomatis kehilangan default-nya.
  app.post<{ Params: { id: string } }>("/api/providers/:id/set-default", async (req) => {
    const id = Number(req.params.id);
    await prisma.aiProvider.updateMany({ data: { isDefault: false } });
    const updated = await prisma.aiProvider.update({
      where: { id },
      data: { isDefault: true },
    });
    invalidateProviderCache();
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    const id = Number(req.params.id);
    const target = await prisma.aiProvider.findUnique({ where: { id } });
    await prisma.aiProvider.delete({ where: { id } });
    // Kalau yang dihapus adalah default, promosikan provider lain (priority tertinggi → id terkecil).
    if (target?.isDefault) {
      const next = await prisma.aiProvider.findFirst({
        orderBy: [{ priority: "desc" }, { id: "asc" }],
      });
      if (next) {
        await prisma.aiProvider.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
    invalidateProviderCache();
    return { ok: true };
  });

  // ============ AI ROLES ============
  app.get("/api/roles", async () => {
    return prisma.aiRole.findMany({ orderBy: { createdAt: "desc" } });
  });

  app.post<{
    Body: { nama: string; systemPrompt: string; isDefault?: boolean };
  }>("/api/roles", async (req, reply) => {
    const { nama, systemPrompt, isDefault } = req.body;
    if (!nama || !systemPrompt) {
      return reply.code(400).send({ error: "nama dan systemPrompt wajib diisi" });
    }
    const created = await prisma.aiRole.create({
      data: { nama, systemPrompt, isDefault: !!isDefault },
    });
    if (created.isDefault) {
      await prisma.aiRole.updateMany({
        where: { id: { not: created.id } },
        data: { isDefault: false },
      });
    }
    return created;
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{ nama: string; systemPrompt: string; isDefault: boolean }>;
  }>("/api/roles/:id", async (req) => {
    const id = Number(req.params.id);
    const updated = await prisma.aiRole.update({ where: { id }, data: req.body });
    if (updated.isDefault) {
      await prisma.aiRole.updateMany({
        where: { id: { not: id } },
        data: { isDefault: false },
      });
    }
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/roles/:id", async (req) => {
    const id = Number(req.params.id);
    await prisma.aiRole.delete({ where: { id } });
    return { ok: true };
  });

  // ============ WHITELIST ============
  app.get("/api/whitelist", async () => {
    const list = await prisma.whitelistedNumber.findMany({
      orderBy: { createdAt: "desc" },
      include: { role: true, provider: true },
    });
    return list;
  });

  app.post<{
    Body: {
      waNumber: string;
      displayName?: string;
      initialContext?: string;
      systemPrompt?: string;
      providerId?: number | null;
      isActive?: boolean;
    };
  }>("/api/whitelist", async (req, reply) => {
    const { waNumber, displayName, initialContext, systemPrompt, providerId, isActive } = req.body;
    const n = normalizeNumber(waNumber || "");
    if (!n) return reply.code(400).send({ error: "waNumber tidak valid" });
    const created = await prisma.whitelistedNumber.create({
      data: {
        waNumber: n,
        displayName: displayName || null,
        initialContext: initialContext || null,
        systemPrompt: systemPrompt?.trim() ? systemPrompt.trim() : null,
        providerId: providerId ?? null,
        isActive: isActive ?? true,
      },
    });
    return created;
  });

  app.put<{
    Params: { id: string };
    Body: Partial<{
      displayName: string | null;
      initialContext: string | null;
      systemPrompt: string | null;
      providerId: number | null;
      isActive: boolean;
    }>;
  }>("/api/whitelist/:id", async (req) => {
    const id = Number(req.params.id);
    const data: Record<string, unknown> = {};
    const b = req.body;
    if (b.displayName !== undefined) data.displayName = b.displayName;
    if (b.initialContext !== undefined) data.initialContext = b.initialContext;
    if (b.systemPrompt !== undefined) data.systemPrompt = b.systemPrompt;
    if (b.providerId !== undefined) data.providerId = b.providerId;
    if (b.isActive !== undefined) data.isActive = b.isActive;
    return prisma.whitelistedNumber.update({ where: { id }, data });
  });

  app.delete<{ Params: { id: string } }>("/api/whitelist/:id", async (req) => {
    const id = Number(req.params.id);
    const entry = await prisma.whitelistedNumber.findUnique({ where: { id } });
    await prisma.whitelistedNumber.delete({ where: { id } });
    if (entry) await resetMemory(entry.waNumber);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/whitelist/:id/reset-memory", async (req) => {
    const id = Number(req.params.id);
    const entry = await prisma.whitelistedNumber.findUnique({ where: { id } });
    if (!entry) return { ok: false };
    await resetMemory(entry.waNumber);
    return { ok: true };
  });

  // ============ CONVERSATION LOGS ============
  app.get<{
    Querystring: { waNumber?: string; from?: string; to?: string; limit?: string };
  }>("/api/logs", async (req) => {
    const { waNumber, from, to, limit } = req.query;
    const where: Record<string, unknown> = {};
    if (waNumber) where.waNumber = normalizeNumber(waNumber);
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.gte = new Date(from);
      if (to) range.lte = new Date(to);
      where.createdAt = range;
    }
    return prisma.conversationLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit || 200), 1000),
    });
  });

  app.get("/api/numbers-with-logs", async () => {
    const rows = await prisma.conversationLog.groupBy({
      by: ["waNumber"],
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return rows
      .map((r) => ({
        waNumber: r.waNumber,
        count: r._count._all,
        lastAt: r._max.createdAt,
      }))
      .sort((a, b) => (b.lastAt?.getTime() || 0) - (a.lastAt?.getTime() || 0));
  });

  // ============ MEMORY SNAPSHOT (initial summary) ============
  app.get<{ Params: { waNumber: string } }>("/api/initial-summary/:waNumber", async (req) => {
    const n = normalizeNumber(req.params.waNumber);
    const snap = await prisma.memorySnapshot.findFirst({
      where: { waNumber: n, isInitial: true },
      orderBy: { createdAt: "desc" },
    });
    return snap || { summary: null };
  });

  // ============ WEBHOOK DIAGNOSTIK ============
  app.get("/api/webhook-log", async () => {
    return { entries: getWebhookLog() };
  });

  app.delete("/api/webhook-log", async () => {
    clearWebhookLog();
    return { ok: true };
  });

  // ============ PROMPT TEMPLATES ============
  app.get("/api/prompts", async () => {
    return { prompts: await listPrompts() };
  });

  app.put<{
    Params: { key: string };
    Body: { content: string };
  }>("/api/prompts/:key", async (req, reply) => {
    const { content } = req.body || ({} as { content?: string });
    if (typeof content !== "string" || content.trim().length === 0) {
      return reply.code(400).send({ error: "content wajib diisi" });
    }
    try {
      await setPrompt(req.params.key, content);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { key: string } }>("/api/prompts/:key", async (req, reply) => {
    try {
      const def = await resetPrompt(req.params.key);
      return { ok: true, defaultContent: def };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ============ PENGATURAN ============
  app.get("/api/settings", async () => {
    return {
      adminUsername: process.env.ADMIN_USERNAME || "admin",
      memorySummarizeEvery: Number(process.env.MEMORY_SUMMARIZE_EVERY || 15),
      memoryRecentLimit: Number(process.env.MEMORY_RECENT_LIMIT || 10),
      wahaUrl: process.env.WAHA_URL || "",
      wahaSession: process.env.WAHA_SESSION || "default",
    };
  });
}
