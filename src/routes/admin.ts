import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { invalidateProviderCache } from "../services/ai-router.js";
import { normalizeNumber } from "../services/whitelist.js";
import { resetMemory } from "../services/memory.js";

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
      isActive?: boolean;
    };
  }>("/api/providers", async (req, reply) => {
    const { nama, provider, model, apiKey, priority, isActive } = req.body;
    if (!nama || !provider || !model || !apiKey) {
      return reply.code(400).send({ error: "nama, provider, model, apiKey wajib diisi" });
    }
    if (!["google", "openai", "deepseek", "groq"].includes(provider)) {
      return reply.code(400).send({ error: "provider harus google|openai|deepseek|groq" });
    }
    const created = await prisma.aiProvider.create({
      data: {
        nama,
        provider,
        model,
        apiKey,
        priority: priority ?? 0,
        isActive: !!isActive,
      },
    });
    if (created.isActive) {
      await prisma.aiProvider.updateMany({
        where: { id: { not: created.id } },
        data: { isActive: false },
      });
      invalidateProviderCache();
    }
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
      isActive: boolean;
    }>;
  }>("/api/providers/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const data: Record<string, unknown> = {};
    const b = req.body;
    if (b.nama !== undefined) data.nama = b.nama;
    if (b.provider !== undefined) data.provider = b.provider;
    if (b.model !== undefined) data.model = b.model;
    if (b.apiKey !== undefined && b.apiKey !== "") data.apiKey = b.apiKey;
    if (b.priority !== undefined) data.priority = b.priority;
    if (b.isActive !== undefined) data.isActive = b.isActive;

    const updated = await prisma.aiProvider.update({ where: { id }, data });
    if (updated.isActive) {
      await prisma.aiProvider.updateMany({
        where: { id: { not: id } },
        data: { isActive: false },
      });
    }
    invalidateProviderCache();
    return updated;
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/activate", async (req) => {
    const id = Number(req.params.id);
    await prisma.aiProvider.updateMany({ data: { isActive: false } });
    const updated = await prisma.aiProvider.update({
      where: { id },
      data: { isActive: true },
    });
    invalidateProviderCache();
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    const id = Number(req.params.id);
    await prisma.aiProvider.delete({ where: { id } });
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
      include: { role: true },
    });
    return list;
  });

  app.post<{
    Body: {
      waNumber: string;
      displayName?: string;
      initialContext?: string;
      roleId?: number | null;
      isActive?: boolean;
    };
  }>("/api/whitelist", async (req, reply) => {
    const { waNumber, displayName, initialContext, roleId, isActive } = req.body;
    const n = normalizeNumber(waNumber || "");
    if (!n) return reply.code(400).send({ error: "waNumber tidak valid" });
    const created = await prisma.whitelistedNumber.create({
      data: {
        waNumber: n,
        displayName: displayName || null,
        initialContext: initialContext || null,
        roleId: roleId ?? null,
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
      roleId: number | null;
      isActive: boolean;
    }>;
  }>("/api/whitelist/:id", async (req) => {
    const id = Number(req.params.id);
    return prisma.whitelistedNumber.update({ where: { id }, data: req.body });
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
