import { Redis } from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(url, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (err) => {
  console.error("[redis] error", err.message);
});

export const memoryKey = (waNumber: string) => `mem:${waNumber}`;
