import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { prisma } from "../lib/prisma.js";
import { buildChatModel, type ProviderType } from "../lib/langchain.js";

let cache: { model: BaseChatModel; key: string } | null = null;

function cacheKey(p: { id: number; provider: string; model: string; apiKey: string }): string {
  return `${p.id}:${p.provider}:${p.model}:${p.apiKey.slice(0, 8)}`;
}

export async function getActiveProvider() {
  const active = await prisma.aiProvider.findFirst({
    where: { isActive: true },
    orderBy: { priority: "desc" },
  });
  if (!active) {
    throw new Error("Tidak ada AI provider aktif. Aktifkan satu provider via dashboard.");
  }
  return active;
}

export async function getActiveChatModel(): Promise<BaseChatModel> {
  const active = await getActiveProvider();
  const key = cacheKey(active);
  if (cache && cache.key === key) {
    return cache.model;
  }
  const model = buildChatModel({
    provider: active.provider as ProviderType,
    model: active.model,
    apiKey: active.apiKey,
  });
  cache = { model, key };
  return model;
}

export function invalidateProviderCache() {
  cache = null;
}
