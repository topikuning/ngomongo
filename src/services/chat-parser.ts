import AdmZip from "adm-zip";
import { HumanMessage } from "@langchain/core/messages";
import { getChatModelForNumber } from "./ai-router.js";
import { renderPrompt, fillPrompt, getPrompt } from "./prompt-store.js";

export interface ParsedMessage {
  date: string;
  time: string;
  sender: string;
  content: string;
}

export interface SenderInfo {
  sender: string;
  count: number;
  samples: string[];
}

const LINE_RE =
  /^\[?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})[,]?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)\]?\s*[-]?\s*([^:]+?):\s*(.*)$/;

// Pesan sistem WhatsApp yang harus dibuang sebelum analisis style/persona —
// kalau ikut diproses, summary akan tercemar (mis. menganggap user sering
// pakai "image omitted").
const SYSTEM_PATTERNS = [
  /end-to-end encrypted/i,
  /<Media omitted>/i,
  /Media tidak disertakan/i,
  /(image|video|audio|GIF|sticker|document|contact card) omitted/i,
  /^You deleted this message/i,
  /^This message was deleted/i,
  /Pesan ini dihapus/i,
  /(Voice|Video|Missed video|Missed voice) call/i,
  /Silenced (voice|video) call/i,
  /\bis a contact\b/i,
  /Tap to call back/i,
  /You changed/i,
];

export function parseWhatsAppExport(raw: string): ParsedMessage[] {
  const lines = raw.split(/\r?\n/);
  const out: ParsedMessage[] = [];
  let buf: ParsedMessage | null = null;

  // Buang invisible chars (U+200E LRM dsb) yang sering ada di export iOS.
  // Tanpa ini regex gagal match di awal baris DAN system-pattern filter
  // gagal match di content (mis. "‎You deleted this message" tidak
  // tertangkap oleh /^You deleted/).
  const stripInvisible = (s: string) => s.replace(/[‎‏‪-‮﻿]/g, "");

  for (const rawLine of lines) {
    const line = stripInvisible(rawLine).replace(/^\s+/, "");
    const m = line.match(LINE_RE);
    if (m) {
      if (buf) out.push(buf);
      buf = {
        date: m[1],
        time: m[2],
        sender: m[3].trim(),
        content: stripInvisible(m[4]).trim(),
      };
    } else if (buf) {
      buf.content += "\n" + stripInvisible(line);
    }
  }
  if (buf) out.push(buf);

  return out.filter((p) => {
    const c = p.content.trim();
    if (c.length === 0) return false;
    for (const pat of SYSTEM_PATTERNS) if (pat.test(c)) return false;
    return true;
  });
}

function groupBySender(messages: ParsedMessage[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of messages) {
    const c = m.content.trim();
    if (c.length === 0) continue;
    if (!map.has(m.sender)) map.set(m.sender, []);
    map.get(m.sender)!.push(c);
  }
  return map;
}

/**
 * Pilih pesan-pesan REPRESENTATIF (verbatim) untuk dipakai sebagai
 * few-shot example di system prompt. Lebih kuat untuk style transfer
 * daripada mendeskripsikan style dengan rules ("tone santai, slang X").
 *
 * Filter:
 *   - Panjang 10-200 char (skip terlalu pendek/panjang)
 *   - Bukan filler ("ok"/"ya"/"haha" dst)
 * Selection:
 *   - Stride evenly across candidates supaya tidak semua dari satu
 *     periode (variety of contexts/topics).
 */
function pickRepresentative(contents: string[], n: number): string[] {
  const candidates = contents.filter(
    (c) =>
      c.length >= 10 &&
      c.length <= 200 &&
      !/^(ok|oke|sip|ya|iya|yes|no|hmm|haha|wkwk|gak|nggak|udah|belum|nanti)\.?$/i.test(c),
  );
  if (candidates.length === 0) return contents.filter((c) => c.length >= 4).slice(0, n);
  const stride = Math.max(1, Math.floor(candidates.length / n));
  const picked: string[] = [];
  for (let i = 0; i < candidates.length && picked.length < n; i += stride) {
    picked.push(candidates[i]);
  }
  return picked;
}

/**
 * Hitung jumlah pesan per partisipan + ambil 5 sample. Dipakai
 * dashboard untuk meminta user memilih peran AI.
 */
export function analyzeSenders(messages: ParsedMessage[]): SenderInfo[] {
  const map = groupBySender(messages);
  return Array.from(map.entries())
    .map(([sender, contents]) => ({
      sender,
      count: contents.length,
      samples: pickRepresentative(contents, 5),
    }))
    .sort((a, b) => b.count - a.count);
}

export function extractTextFromBuffer(buf: Buffer, filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    const txtEntries = entries
      .filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith(".txt"))
      .sort((a, b) => b.header.size - a.header.size);
    if (txtEntries.length === 0) {
      throw new Error("File .zip tidak berisi .txt export WhatsApp");
    }
    return txtEntries[0].getData().toString("utf-8");
  }
  return buf.toString("utf-8");
}

// Kirim PENUH ke LLM — tidak ada sampling default. User ingin AI lihat
// seluruh history supaya style/kondisi terkini akurat. Cap hanya sebagai
// safety net kalau ukuran benar-benar ekstrem (mis. > 1.5M karakter,
// di luar konteks model paling besar sekalipun) — saat itu fallback
// pakai start+middle+end. Default cap dinaikkan jauh dari 16K → 1.2M.
function takeSample(messages: ParsedMessage[], maxChars = 1_200_000): string {
  const joined = messages.map((m) => `${m.sender}: ${m.content}`).join("\n");
  if (joined.length <= maxChars) return joined;
  const chunkSize = Math.floor(maxChars / 3);
  const start = joined.slice(0, chunkSize);
  const midPos = Math.max(0, Math.floor(joined.length / 2) - Math.floor(chunkSize / 2));
  const middle = joined.slice(midPos, midPos + chunkSize);
  const end = joined.slice(-chunkSize);
  return `${start}\n...\n[CHAT TERLALU PANJANG — bagian tengah dipangkas untuk fit dalam context window]\n...\n${middle}\n...\n${end}`;
}

/**
 * Bangun summary terstruktur dengan pendekatan HYBRID:
 *
 *   - Identitas (nama AI / lawan)      → dari user picker (deterministic)
 *   - Contoh pesan verbatim            → hand-extracted dari raw parse,
 *                                        TIDAK lewat LLM (supaya tidak
 *                                        kehilangan rhythm/typo asli)
 *   - Hubungan / kebiasaan / fakta     → LLM analyze (open-ended)
 *   - Aturan peran                     → hand-built (template tetap)
 *
 * Few-shot examples > rules-based untuk style transfer. Dengan
 * menempelkan ~12 contoh pesan asli AI persona di system prompt, AI
 * runtime meniru rhythm/panjang/kebiasaan secara organik, bukan dengan
 * "stuffing" daftar slang ke setiap balasan (yang sebelumnya
 * menghasilkan pola robotic seperti "ya, km, gpp kok, sayang").
 */
export async function summarizeChatExport(
  messages: ParsedMessage[],
  waNumber: string,
  aiSenderName: string,
  manualContext?: string,
): Promise<string> {
  const bySender = groupBySender(messages);
  const aiMessages = bySender.get(aiSenderName);
  if (!aiMessages || aiMessages.length === 0) {
    throw new Error(`Sender "${aiSenderName}" tidak ditemukan di chat ini`);
  }
  let humanName = "(tidak diketahui)";
  let humanMessages: string[] = [];
  for (const [sender, msgs] of bySender) {
    if (sender !== aiSenderName && msgs.length > humanMessages.length) {
      humanName = sender;
      humanMessages = msgs;
    }
  }

  // FEW-SHOT EXAMPLES — verbatim, no LLM rewriting.
  const aiExamples = pickRepresentative(aiMessages, 12);
  const humanExamples = pickRepresentative(humanMessages, 6);

  // LLM hanya menganalisis hubungan/topik/fakta — TIDAK mendikte
  // gaya bicara (gaya datang dari contoh verbatim).
  const sample = takeSample(messages);
  const prompt = await renderPrompt("summary.chat-export.analysis", {
    aiSenderName,
    humanName,
    manualContext: manualContext ? `Konteks tambahan dari admin: ${manualContext}\n\n` : "",
    sample,
  });

  const model = await getChatModelForNumber(waNumber);
  const res = await model.invoke([new HumanMessage(prompt)]);
  const llmAnalysis = (
    typeof res.content === "string" ? res.content : JSON.stringify(res.content)
  ).trim();

  const aiBullets = aiExamples.map((e) => `• "${e}"`).join("\n");
  const humanBullets = humanExamples.map((e) => `• "${e}"`).join("\n");
  const template = await getPrompt("summary.chat-export.template");
  return fillPrompt(template, {
    aiName: aiSenderName,
    humanName,
    aiBullets,
    humanBullets,
    llmAnalysis,
  });
}

/**
 * Versi summary tanpa riwayat chat — hanya teks deskriptif singkat
 * dari admin. Tetap pakai format terkunci yang sama supaya behavior AI
 * konsisten antara nomor yang punya upload export dan yang tidak.
 */
export async function buildInitialSummaryFromText(
  manualContext: string,
  waNumber: string,
  options?: { aiPersonaName?: string; humanName?: string },
): Promise<string> {
  const aiName = options?.aiPersonaName || "(persona AI sesuai role di tab Role AI)";
  const humanName = options?.humanName || "(lawan bicara — nama dari whitelist)";

  const prompt = await renderPrompt("summary.text-only", {
    aiName,
    humanName,
    manualContext,
  });

  const model = await getChatModelForNumber(waNumber);
  const res = await model.invoke([new HumanMessage(prompt)]);
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return content.trim();
}
