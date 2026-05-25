import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { getDefaultProvider, getDefaultChatModel } from "../services/ai-router.js";
import { pingWahaSession } from "../services/waha-client.js";

interface CheckResult {
  service: string;
  status: "ok" | "error" | "warn";
  latencyMs: number;
  message: string;
  details?: Record<string, unknown>;
}

function ms(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

async function checkDatabase(): Promise<CheckResult> {
  const start = process.hrtime.bigint();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      service: "database",
      status: "ok",
      latencyMs: ms(start),
      message: "Koneksi PostgreSQL OK",
    };
  } catch (err) {
    return {
      service: "database",
      status: "error",
      latencyMs: ms(start),
      message: (err as Error).message,
    };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const start = process.hrtime.bigint();
  try {
    const pong = await redis.ping();
    return {
      service: "redis",
      status: pong === "PONG" ? "ok" : "warn",
      latencyMs: ms(start),
      message: `Redis ${pong}`,
    };
  } catch (err) {
    return {
      service: "redis",
      status: "error",
      latencyMs: ms(start),
      message: (err as Error).message,
    };
  }
}

async function checkAi(): Promise<CheckResult> {
  const start = process.hrtime.bigint();
  try {
    const provider = await getDefaultProvider();
    const model = await getDefaultChatModel();
    const res = await model.invoke([
      new HumanMessage(
        "Balas hanya dengan satu kata: PONG. Jangan tambahkan teks lain.",
      ),
    ]);
    const reply =
      typeof res.content === "string"
        ? res.content
        : JSON.stringify(res.content);
    const trimmed = reply.trim();
    if (!trimmed) {
      return {
        service: "ai",
        status: "error",
        latencyMs: ms(start),
        message: "Provider merespons tapi balasannya kosong",
        details: { provider: provider.provider, model: provider.model },
      };
    }
    return {
      service: "ai",
      status: "ok",
      latencyMs: ms(start),
      message: `${provider.nama} (${provider.provider} · ${provider.model}) merespons: "${trimmed.slice(0, 80)}"`,
      details: {
        provider: provider.provider,
        model: provider.model,
        providerName: provider.nama,
        reply: trimmed.slice(0, 200),
      },
    };
  } catch (err) {
    return {
      service: "ai",
      status: "error",
      latencyMs: ms(start),
      message: (err as Error).message,
    };
  }
}

async function checkWaha(): Promise<CheckResult> {
  const start = process.hrtime.bigint();
  const info = await pingWahaSession();
  if (!info.ok) {
    return {
      service: "waha",
      status: "error",
      latencyMs: ms(start),
      message:
        info.status === 0
          ? `Tidak bisa connect ke ${info.url}: ${info.error}`
          : `WAHA ${info.url} balas HTTP ${info.status}: ${info.error?.slice(0, 200) || ""}`,
      details: { url: info.url, httpStatus: info.status },
    };
  }
  const working = info.sessionStatus === "WORKING";
  return {
    service: "waha",
    status: working ? "ok" : "warn",
    latencyMs: ms(start),
    message: working
      ? `Session "${info.sessionName}" status WORKING`
      : `Session "${info.sessionName}" status: ${info.sessionStatus || "UNKNOWN"} (belum siap kirim/terima)`,
    details: {
      url: info.url,
      sessionStatus: info.sessionStatus,
      sessionName: info.sessionName,
    },
  };
}

const CHECKS: Record<string, () => Promise<CheckResult>> = {
  database: checkDatabase,
  redis: checkRedis,
  ai: checkAi,
  waha: checkWaha,
};

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/health/all", async () => {
    const results = await Promise.all(Object.values(CHECKS).map((fn) => fn()));
    const overall = results.every((r) => r.status === "ok")
      ? "ok"
      : results.some((r) => r.status === "error")
      ? "error"
      : "warn";
    return { overall, ts: Date.now(), results };
  });

  app.get<{ Params: { service: string } }>(
    "/api/health/:service",
    async (req, reply) => {
      const fn = CHECKS[req.params.service];
      if (!fn) {
        return reply
          .code(404)
          .send({ error: `Service tidak dikenal. Pilihan: ${Object.keys(CHECKS).join(", ")}` });
      }
      return fn();
    },
  );
}
