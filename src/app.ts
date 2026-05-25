import Fastify from "fastify";
import multipart from "@fastify/multipart";
import basicAuth from "@fastify/basic-auth";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { webhookRoutes } from "./routes/webhook.js";
import { adminRoutes } from "./routes/admin.js";
import { uploadRoutes } from "./routes/upload.js";
import { healthRoutes } from "./routes/health.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function buildApp() {
  // Di production gunakan logger JSON default; pino-pretty hanya jika
  // tersedia secara opsional (dev). Hindari hard-require pino-pretty supaya
  // bundle production tetap kecil dan tidak crash saat tidak terpasang.
  let prettyTransport: { target: string; options: object } | undefined;
  if (process.env.NODE_ENV !== "production") {
    try {
      const mod = "pino-pretty";
      await import(/* @vite-ignore */ mod);
      prettyTransport = { target: "pino-pretty", options: { colorize: true } };
    } catch {
      // pino-pretty tidak terpasang — pakai logger JSON default
    }
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      transport: prettyTransport,
    },
    bodyLimit: 30 * 1024 * 1024, // 30 MB untuk export chat WA
  });

  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: 30 * 1024 * 1024,
      files: 1,
    },
  });

  // Basic auth untuk semua /api/* dan /dashboard
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "";

  await app.register(basicAuth, {
    validate: async (username, password, _req, _reply) => {
      if (!adminPass) {
        throw new Error("ADMIN_PASSWORD belum di-set di environment");
      }
      if (username !== adminUser || password !== adminPass) {
        throw new Error("Kredensial salah");
      }
    },
    authenticate: { realm: "ngomongo-admin" },
  });

  // Route publik (tidak butuh auth): webhook & health
  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
  await app.register(webhookRoutes);

  // Route admin (semua butuh basic auth)
  app.register(async (scope) => {
    scope.addHook("onRequest", app.basicAuth);
    await scope.register(adminRoutes);
    await scope.register(uploadRoutes);
    await scope.register(healthRoutes);

    // Serve dashboard HTML
    scope.register(fastifyStatic, {
      root: path.resolve(__dirname, "dashboard"),
      prefix: "/dashboard/",
      decorateReply: false,
    });

    scope.get("/", async (_req, reply) => {
      return reply.redirect("/dashboard/");
    });
  });

  return app;
}
