import { HumanMessage, AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { prisma } from "../lib/prisma.js";
import { redis, memoryKey } from "../lib/redis.js";
import { getActiveChatModel } from "./ai-router.js";
import { normalizeNumber } from "./whitelist.js";

const SUMMARIZE_EVERY = Number(process.env.MEMORY_SUMMARIZE_EVERY || 15);
const RECENT_LIMIT = Number(process.env.MEMORY_RECENT_LIMIT || 10);

export interface RecentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface UserProfile {
  display_name?: string;
  language_style?: string;
}

export interface MemoryState {
  summary: string;
  recent_messages: RecentMessage[];
  user_profile: UserProfile;
  messages_since_summary: number;
}

const EMPTY_MEMORY: MemoryState = {
  summary: "",
  recent_messages: [],
  user_profile: {},
  messages_since_summary: 0,
};

async function loadFromRedis(waNumber: string): Promise<MemoryState | null> {
  const raw = await redis.get(memoryKey(waNumber));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MemoryState;
  } catch {
    return null;
  }
}

async function saveToRedis(waNumber: string, state: MemoryState): Promise<void> {
  await redis.set(memoryKey(waNumber), JSON.stringify(state));
}

async function loadInitialFromDb(waNumber: string): Promise<MemoryState> {
  const initial = await prisma.memorySnapshot.findFirst({
    where: { waNumber, isInitial: true },
    orderBy: { createdAt: "desc" },
  });
  const entry = await prisma.whitelistedNumber.findUnique({
    where: { waNumber },
  });
  const state: MemoryState = {
    ...EMPTY_MEMORY,
    recent_messages: [],
    user_profile: { display_name: entry?.displayName ?? undefined },
  };
  if (initial) {
    state.summary = initial.summary;
  } else if (entry?.initialContext) {
    state.summary =
      "=== KONTEKS ===\n" +
      entry.initialContext +
      "\n\n=== STYLE BAHASA ===\nBelum ada data style. Gunakan bahasa yang natural dan ramah.";
  }
  return state;
}

export async function getMemory(waNumber: string): Promise<MemoryState> {
  const n = normalizeNumber(waNumber);
  const cached = await loadFromRedis(n);
  if (cached) return cached;
  const fresh = await loadInitialFromDb(n);
  await saveToRedis(n, fresh);
  return fresh;
}

export async function resetMemory(waNumber: string): Promise<void> {
  const n = normalizeNumber(waNumber);
  await redis.del(memoryKey(n));
}

export function buildMessagesForLLM(
  systemPrompt: string,
  memory: MemoryState,
  userMessage: string,
): BaseMessage[] {
  const parts: string[] = [systemPrompt.trim()];
  if (memory.summary) {
    parts.push(
      "\n\nBerikut konteks dan style bahasa orang yang sedang kamu ajak bicara — WAJIB tiru style bahasanya saat membalas:\n" +
        memory.summary,
    );
  }
  const messages: BaseMessage[] = [new SystemMessage(parts.join(""))];
  for (const m of memory.recent_messages) {
    messages.push(m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content));
  }
  messages.push(new HumanMessage(userMessage));
  return messages;
}

async function summarize(
  oldSummary: string,
  messages: RecentMessage[],
): Promise<string> {
  const model = await getActiveChatModel();
  const convo = messages
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
    .join("\n");

  const prompt = `Berikut ringkasan percakapan sebelumnya:
${oldSummary || "(belum ada)"}

Berikut percakapan terbaru:
${convo}

Tugasmu: tulis ulang ringkasan dalam format BERIKUT (pertahankan blok jika sudah ada, perbarui dengan info baru). Jangan tambahkan komentar lain.

=== KONTEKS ===
[ringkasan singkat siapa orang ini, topik yang sering dibahas, hal penting yang diketahui tentangnya]

=== STYLE BAHASA ===
[deskripsi cara dia menulis: formal/informal, singkatan yang sering dipakai, panjang pesan tipikal, penggunaan emoji, tone, contoh frasa khas]`;

  // Gemini menolak request yang hanya berisi SystemMessage (contents kosong).
  // Kirim sebagai HumanMessage agar kompatibel dgn semua provider.
  const res = await model.invoke([new HumanMessage(prompt)]);
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return content.trim();
}

export async function appendAndMaybeSummarize(
  waNumber: string,
  userMessage: string,
  aiReply: string,
): Promise<void> {
  const n = normalizeNumber(waNumber);
  const memory = await getMemory(n);

  memory.recent_messages.push({ role: "user", content: userMessage });
  memory.recent_messages.push({ role: "assistant", content: aiReply });
  memory.messages_since_summary += 2;

  // Pertahankan hanya RECENT_LIMIT pesan terakhir di buffer
  if (memory.recent_messages.length > RECENT_LIMIT) {
    memory.recent_messages = memory.recent_messages.slice(-RECENT_LIMIT);
  }

  await prisma.conversationLog.createMany({
    data: [
      { waNumber: n, role: "user", content: userMessage },
      { waNumber: n, role: "assistant", content: aiReply },
    ],
  });

  if (memory.messages_since_summary >= SUMMARIZE_EVERY) {
    try {
      const newSummary = await summarize(memory.summary, memory.recent_messages);
      memory.summary = newSummary;
      memory.messages_since_summary = 0;
      await prisma.memorySnapshot.create({
        data: {
          waNumber: n,
          summary: newSummary,
          messageCount: memory.recent_messages.length,
          isInitial: false,
        },
      });
    } catch (err) {
      console.error("[memory] gagal summarize:", (err as Error).message);
    }
  }

  await saveToRedis(n, memory);
}

export async function setInitialSummary(
  waNumber: string,
  summary: string,
): Promise<void> {
  const n = normalizeNumber(waNumber);
  await prisma.memorySnapshot.create({
    data: { waNumber: n, summary, isInitial: true, messageCount: 0 },
  });
  await prisma.whitelistedNumber.update({
    where: { waNumber: n },
    data: { initialSummaryReady: true },
  });
  // Reset cache di Redis supaya summary baru ter-load saat percakapan berikutnya
  await redis.del(memoryKey(n));
}
