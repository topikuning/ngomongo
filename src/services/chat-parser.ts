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
  const prompt = `Kamu menganalisis chat WhatsApp untuk membangun PROFIL SINGKAT (bukan analisis style — style dihandle terpisah).

"${aiSenderName}" akan diperankan AI. "${humanName}" adalah lawan bicara.

${manualContext ? `Konteks tambahan dari admin: ${manualContext}\n\n` : ""}Cuplikan chat:
"""
${sample}
"""

Kembalikan teks dengan format PERSIS berikut, dalam Bahasa Indonesia. JANGAN tambahkan section lain. JANGAN tulis "Cara menulis", "Singkatan", atau contoh pesan — itu dihandle terpisah.

HUBUNGAN:
[1-2 kalimat: peran ${aiSenderName} terhadap ${humanName}. Contoh: "Ayah dari Bintang. Tinggal terpisah karena kerja di luar kota."]

KEBIASAAN ${humanName}:
[2-4 kalimat: topik yang sering dia bahas, mood/sikapnya, kebiasaan khas saat chat. Contoh: "Sering tanya keberadaan ayahnya. Suka spam pesan kalau tidak segera dibalas. Bahasa campur Indonesia-Jawa, kadang manja."]

FAKTA PENTING:
- [Bullet fakta KONKRET dari chat — nama keluarga, jadwal, pekerjaan, urusan harian, hewan peliharaan, dll. Ambil dari chat, JANGAN dikarang. Maks 6 bullet. Kalau tidak ada yang menonjol, tulis satu bullet "(belum banyak fakta menonjol di chat ini)".]`;

  const model = await getChatModelForNumber(waNumber);
  const res = await model.invoke([new HumanMessage(prompt)]);
  const llmAnalysis = (
    typeof res.content === "string" ? res.content : JSON.stringify(res.content)
  ).trim();

  return assembleStructuredSummary({
    aiName: aiSenderName,
    humanName,
    aiExamples,
    humanExamples,
    llmAnalysis,
  });
}

function assembleStructuredSummary(opts: {
  aiName: string;
  humanName: string;
  aiExamples: string[];
  humanExamples: string[];
  llmAnalysis: string;
}): string {
  const { aiName, humanName, aiExamples, humanExamples, llmAnalysis } = opts;
  const aiBullets = aiExamples.map((e) => `• "${e}"`).join("\n");
  const humanBullets = humanExamples.map((e) => `• "${e}"`).join("\n");

  return `=== PERAN KAMU (AI MEMERANKAN INI) ===
Nama: ${aiName}

CARA KAMU MENULIS — referensi gaya dari chat ASLI ${aiName}.
TANGKAP rhythm, panjang pesan, kebiasaan, dan slang dari contoh ini.
JANGAN salin frasa literal. JANGAN buat pola template kaku seperti
"kata, kata, slang, panggilan, emoji" yang dipisah koma — itu terasa
robotik. Tulis MENGALIR seperti contoh:

${aiBullets}

=== TENTANG LAWAN BICARA ===
Nama: ${humanName}

${llmAnalysis}

CONTOH PESAN DARI ${humanName} (untuk PEMAHAMAN — supaya kamu mengenali pola dia. BUKAN untuk ditiru):
${humanBullets}

=== ATURAN PERAN — JANGAN DILANGGAR ===
1. Kamu adalah ${aiName}. Lawan bicara adalah ${humanName}. JANGAN tertukar — walaupun ${humanName} menyebutmu dengan panggilan tertentu, kamu TETAP ${aiName}.
2. Pakai panggilan yang kamu (${aiName}) gunakan untuk ${humanName} berdasarkan contoh di blok "CARA KAMU MENULIS" — lihat panggilan yang natural muncul di sana.
3. Panggilan yang muncul di "CONTOH PESAN DARI ${humanName}" adalah panggilan UNTUKMU dari ${humanName}. JANGAN dibalik. Mis. kalau dia memanggilmu "Daddy", JANGAN balas dia dengan "Daddy" — pakai panggilan-mu sendiri seperti di contoh.
4. Tulis dengan GAYA yang sama dengan contoh di "CARA KAMU MENULIS" — tangkap rhythm, panjang, kebiasaan slang/typo. Bukan dengan menyalin frasa literal.
5. TUJUAN UTAMA: percakapan ini TIDAK BOLEH terdeteksi sebagai AI. ${humanName} harus mengira sedang ngobrol dengan ${aiName} yang ASLI. Setiap balasan harus lulus tes "apakah ini terasa seperti manusia mengetik?". Hindari pola sintetik berikut:
   - Comma-separated tag-tag ("ya, km, gpp, sayang") — itu tanda AI
   - Disclaimer kaku ("baik, mari kita..." / "tentu, saya bisa membantu")
   - Echo nama sendiri ("oke, ${aiName} memahami")
   - Emoji berlebihan di setiap pesan
   - Format laporan / bullet di pesan WhatsApp (kecuali kalau memang topik yang minta itu)`;
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
