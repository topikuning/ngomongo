import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import { prisma } from "../lib/prisma.js";
import { buildChatModel, type ProviderType } from "../lib/langchain.js";
import { normalizeNumber } from "./whitelist.js";
import { getPrompt } from "./prompt-store.js";

export interface ProviderRow {
  id: number;
  nama: string;
  provider: string;
  model: string;
  apiKey: string;
  isDefault: boolean;
}

const modelCache = new Map<string, BaseChatModel>();

function cacheKey(p: ProviderRow): string {
  return `${p.id}:${p.provider}:${p.model}:${p.apiKey.slice(0, 8)}`;
}

function modelFor(p: ProviderRow): BaseChatModel {
  const key = cacheKey(p);
  let m = modelCache.get(key);
  if (!m) {
    m = buildChatModel({
      provider: p.provider as ProviderType,
      model: p.model,
      apiKey: p.apiKey,
    });
    modelCache.set(key, m);
  }
  return m;
}

export async function getDefaultProvider(): Promise<ProviderRow> {
  const def = await prisma.aiProvider.findFirst({
    where: { isDefault: true },
    orderBy: { priority: "desc" },
  });
  if (!def) {
    throw new Error(
      "Belum ada provider AI default. Tandai satu provider sebagai default di dashboard.",
    );
  }
  return def;
}

export async function getDefaultChatModel(): Promise<BaseChatModel> {
  return modelFor(await getDefaultProvider());
}

/** Pilih provider untuk nomor tertentu — pakai override per-nomor kalau ada, kalau tidak fallback ke default global. */
export async function getProviderForNumber(waNumber: string): Promise<ProviderRow> {
  const n = normalizeNumber(waNumber);
  if (n) {
    const entry = await prisma.whitelistedNumber.findUnique({
      where: { waNumber: n },
      include: { provider: true },
    });
    if (entry?.provider) return entry.provider;
  }
  return getDefaultProvider();
}

export async function getChatModelForNumber(waNumber: string): Promise<BaseChatModel> {
  return modelFor(await getProviderForNumber(waNumber));
}

export function invalidateProviderCache() {
  modelCache.clear();
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}

/** Tes satu provider tertentu (tanpa mengubah default). */
export async function testProvider(p: ProviderRow): Promise<ProviderTestResult> {
  const start = Date.now();
  try {
    const model = modelFor(p);
    const pingPrompt = await getPrompt("health.ping");
    const res = await model.invoke([new HumanMessage(pingPrompt)]);
    const text =
      typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, latencyMs: Date.now() - start, error: "Provider merespons tapi balasannya kosong" };
    }
    return { ok: true, latencyMs: Date.now() - start, reply: trimmed.slice(0, 300) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}
