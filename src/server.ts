import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

// Log boot eksplisit via stdout — muncul lebih awal dari Fastify/pino,
// membantu diagnosa di Railway kalau ada masalah inisialisasi.
console.log(
  `[boot] ngomongo starting · node ${process.version} · port ${PORT} · NODE_ENV=${process.env.NODE_ENV || "development"}`,
);

if (!process.env.DATABASE_URL) {
  console.error("[boot] FATAL: DATABASE_URL tidak ter-set");
  process.exit(1);
}
if (!process.env.REDIS_URL) {
  console.error("[boot] FATAL: REDIS_URL tidak ter-set");
  process.exit(1);
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[boot] ngomongo ready · listening on ${HOST}:${PORT}`);
    app.log.info(`ngomongo siap di http://${HOST}:${PORT}`);
  } catch (err) {
    console.error("[boot] FATAL gagal listen:", err);
    process.exit(1);
  }
}

process.on("unhandledRejection", (err) => {
  console.error("[boot] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[boot] uncaughtException:", err);
});

main();
