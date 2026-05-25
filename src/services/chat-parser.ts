import AdmZip from "adm-zip";
import { HumanMessage } from "@langchain/core/messages";
import { getChatModelForNumber } from "./ai-router.js";

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

/**
 * Hitung jumlah pesan per partisipan + ambil 5 sample pesan
 * non-trivial (>6 char, bukan filler "ok"/"ya"/"haha"). Dipakai
 * dashboard untuk meminta user memilih peran AI.
 */
export function analyzeSenders(messages: ParsedMessage[]): SenderInfo[] {
  const map = new Map<string, string[]>();
  for (const m of messages) {
    const c = m.content.trim();
    if (!map.has(m.sender)) map.set(m.sender, []);
    map.get(m.sender)!.push(c);
  }
  return Array.from(map.entries())
    .map(([sender, contents]) => ({
      sender,
      count: contents.length,
      samples: pickSamples(contents, 5),
    }))
    .sort((a, b) => b.count - a.count);
}

function pickSamples(contents: string[], n: number): string[] {
  const candidates = contents.filter(
    (c) => c.length > 6 && !/^(ok|oke|sip|ya|iya|yes|no|hmm|haha|wkwk)\.?$/i.test(c),
  );
  if (candidates.length === 0) return contents.slice(0, n);
  const stride = Math.max(1, Math.floor(candidates.length / n));
  const picked: string[] = [];
  for (let i = 0; i < candidates.length && picked.length < n; i += stride) {
    picked.push(candidates[i]);
  }
  return picked;
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

function takeSample(messages: ParsedMessage[], maxChars = 16000): string {
  const joined = messages.map((m) => `${m.sender}: ${m.content}`).join("\n");
  if (joined.length <= maxChars) return joined;
  const chunkSize = Math.floor(maxChars / 3);
  const start = joined.slice(0, chunkSize);
  const midPos = Math.max(0, Math.floor(joined.length / 2) - Math.floor(chunkSize / 2));
  const middle = joined.slice(midPos, midPos + chunkSize);
  const end = joined.slice(-chunkSize);
  return `${start}\n...\n${middle}\n...\n${end}`;
}

/**
 * Hasilkan summary terstruktur yang MENGUNCI peran AI:
 *
 *   === PERAN KAMU ===            ← apa peran AI, gaya bicara AI, panggilan AI untuk lawan
 *   === TENTANG LAWAN BICARA ===  ← profil lawan, gaya dia, panggilan dia untuk AI
 *   === ATURAN PERAN ===          ← instruksi tegas "jangan tertukar"
 *
 * Format ini di-konsumsi langsung sebagai bagian system prompt — AI
 * tidak bisa lagi "membalik" peran karena setiap blok eksplisit
 * memisahkan siapa-melakukan-apa.
 */
export async function summarizeChatExport(
  messages: ParsedMessage[],
  waNumber: string,
  aiSenderName: string,
  manualContext?: string,
): Promise<string> {
  const senders = analyzeSenders(messages);
  const humanInfo = senders.find((s) => s.sender !== aiSenderName);
  const humanName = humanInfo?.sender || "(tidak diketahui)";
  const sample = takeSample(messages);

  const prompt = `Kamu menganalisis riwayat WhatsApp untuk membangun profil persona yang akan dipakai AI memerankan salah satu peserta.

Pemetaan peran (WAJIB diikuti):
- "${aiSenderName}" = yang akan diperankan AI (saat membalas, AI BERTINDAK SEBAGAI "${aiSenderName}")
- "${humanName}" = lawan bicara AI

${manualContext ? `Konteks tambahan dari admin:\n${manualContext}\n\n` : ""}Cuplikan chat:
"""
${sample}
"""

Hasilkan teks dengan format PERSIS berikut, dalam Bahasa Indonesia, tanpa komentar lain. Isi setiap [...] dengan deduksi konkret dari cuplikan. Kalau suatu informasi tidak terlihat di chat, tulis "(tidak terlihat di chat)".

=== PERAN KAMU (AI MEMERANKAN INI) ===
Nama: ${aiSenderName}
Peran terhadap lawan bicara: [deduksi: ayah/ibu/anak/teman/atasan/pasangan/kolega/CS/dst — pilih istilah paling jelas dari chat]
Cara KAMU menulis (gambaran umum, fleksibel sesuai konteks):
- Tone dominan: [santai/formal/playful/dingin/manja/galak/dst — pilih yang paling umum, tapi tidak mutlak]
- Singkatan & slang yang KAMU pakai: [3-5 contoh persis dari chat]
- Panjang pesan: [variabel, tipikal pendek/sedang/panjang — boleh menyesuaikan konteks]
- Emoji: [jarang/sering + jenis tertentu kalau ada]
- KAMU memanggil lawan bicara dengan: [kata panggilan PERSIS yang ${aiSenderName} pakai untuk ${humanName} di chat — boleh 1-3 variasi]

=== TENTANG LAWAN BICARA ===
Nama: ${humanName}
Peran terhadap kamu: [anak/teman/saudara/pelanggan/atasan/dst]
Cara DIA menulis (untuk PEMAHAMAN saja, BUKAN ditiru):
- Tone: [...]
- Singkatan & slang yang DIA pakai: [...]
- DIA memanggil kamu dengan: [kata panggilan PERSIS yang ${humanName} pakai untuk ${aiSenderName} — ini SANGAT PENTING dicatat]
- Topik yang sering dia bahas: [3-5 topik]
- Hal penting yang pernah dia sampaikan: [fakta yang berguna untuk kontinuitas, mis. nama saudara, hewan peliharaan, jadwal, dll]

=== ATURAN PERAN — KRITIS, JANGAN DILANGGAR ===
1. Kamu adalah ${aiSenderName}. Lawan bicara adalah ${humanName}. JANGAN PERNAH TERTUKAR.
2. Pakai panggilan dari blok "KAMU memanggil lawan bicara" untuk menyebut ${humanName}.
3. Panggilan di blok "DIA memanggil kamu" adalah panggilan UNTUKMU — BUKAN panggilan yang kamu balikkan ke dia.
4. Cara KAMU menulis di atas adalah PANDUAN, bukan resep kaku. Balas natural seperti manusia ngobrol — kadang lebih panjang/pendek/hangat dari tipikal kalau konteks butuh.`;

  const model = await getChatModelForNumber(waNumber);
  const res = await model.invoke([new HumanMessage(prompt)]);
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return content.trim();
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

  const prompt = `Berdasarkan deskripsi singkat berikut tentang seorang kontak WhatsApp:

"${manualContext}"

Pemetaan peran:
- "${aiName}" = peran yang akan diperankan AI saat membalas
- "${humanName}" = lawan bicara

Hasilkan teks dengan format PERSIS berikut, dalam Bahasa Indonesia, tanpa komentar lain:

=== PERAN KAMU (AI MEMERANKAN INI) ===
Nama: ${aiName}
Peran terhadap lawan bicara: [deduksi dari konteks; kalau tidak jelas tulis "(belum jelas)"]
Cara KAMU menulis (sarankan berdasarkan konteks):
- Tone: [pilih satu yang masuk akal: santai/formal/profesional/playful]
- Panggilan KAMU untuk lawan bicara: [sarankan: nama, "kak", "pak", atau panggilan netral sesuai peran]

=== TENTANG LAWAN BICARA ===
Nama: ${humanName}
Peran terhadap kamu: [dari konteks]
Cara dia menulis: (belum diketahui — saat percakapan jalan, summary akan diperbarui)
Panggilan DIA untukmu: (belum diketahui)
Topik relevan: [dari konteks]

=== ATURAN PERAN — KRITIS, JANGAN DILANGGAR ===
1. Kamu adalah ${aiName}. Lawan bicara adalah ${humanName}. JANGAN TERTUKAR.
2. Pakai panggilan yang sesuai PERANMU di blok atas.
3. Jangan tiru panggilan yang dia pakai untukmu — itu untukmu, bukan untuk dibalikkan.`;

  const model = await getChatModelForNumber(waNumber);
  const res = await model.invoke([new HumanMessage(prompt)]);
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return content.trim();
}
