import AdmZip from "adm-zip";
import { HumanMessage } from "@langchain/core/messages";
import { getActiveChatModel } from "./ai-router.js";

export interface ParsedMessage {
  date: string;
  time: string;
  sender: string;
  content: string;
}

const LINE_RE =
  /^\[?(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})[,]?\s+(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)\]?\s*[-]?\s*([^:]+?):\s*(.*)$/;

export function parseWhatsAppExport(raw: string): ParsedMessage[] {
  const lines = raw.split(/\r?\n/);
  const out: ParsedMessage[] = [];
  let buf: ParsedMessage | null = null;

  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (m) {
      if (buf) out.push(buf);
      buf = {
        date: m[1],
        time: m[2],
        sender: m[3].trim(),
        content: m[4],
      };
    } else if (buf) {
      // Lanjutan pesan multi-baris
      buf.content += "\n" + line;
    }
  }
  if (buf) out.push(buf);

  // Buang baris sistem (e.g. "Messages and calls are end-to-end encrypted")
  return out.filter(
    (p) =>
      p.content.length > 0 &&
      !/end-to-end encrypted/i.test(p.content) &&
      !/<Media omitted>/i.test(p.content) &&
      !/Media tidak disertakan/i.test(p.content),
  );
}

export function extractTextFromBuffer(buf: Buffer, filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    // Cari .txt terbesar di dalam zip
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
  // Ambil sebagian dari awal, tengah, akhir agar style & topik representatif
  const joined = messages.map((m) => `${m.sender}: ${m.content}`).join("\n");
  if (joined.length <= maxChars) return joined;

  const chunkSize = Math.floor(maxChars / 3);
  const start = joined.slice(0, chunkSize);
  const midPos = Math.max(0, Math.floor(joined.length / 2) - Math.floor(chunkSize / 2));
  const middle = joined.slice(midPos, midPos + chunkSize);
  const end = joined.slice(-chunkSize);
  return `${start}\n...\n${middle}\n...\n${end}`;
}

export async function summarizeChatExport(
  messages: ParsedMessage[],
  contactHint?: string,
  manualContext?: string,
): Promise<string> {
  const sample = takeSample(messages);
  const senders = Array.from(new Set(messages.map((m) => m.sender)));

  const prompt = `Kamu menerima cuplikan percakapan WhatsApp berikut antara beberapa orang:
Pengirim yang terdeteksi: ${senders.join(", ")}
${contactHint ? `Fokus pada kontak: ${contactHint}` : ""}
${manualContext ? `\nKonteks manual tambahan dari admin:\n${manualContext}\n` : ""}

Cuplikan percakapan:
"""
${sample}
"""

Tugasmu: hasilkan SATU teks dengan format PERSIS seperti di bawah ini, dalam Bahasa Indonesia, tanpa komentar lain. Fokus pada kontak utama (bukan diri sendiri).

=== KONTEKS ===
[Ringkasan: siapa orang ini, hubungannya, topik yang sering dibahas, kebiasaan, hal penting yang pernah disampaikan]

=== STYLE BAHASA ===
[Deskripsi konkret: formal/informal, singkatan & slang yang sering dipakai (contoh: "gw", "lo", "bgt"), panjang pesan tipikal, penggunaan emoji, tone (santai/serius/bercanda), contoh 2-3 frasa khas yang dia pakai]`;

  const model = await getActiveChatModel();
  // Gemini menolak request yang hanya berisi SystemMessage (contents kosong).
  // Kirim sebagai HumanMessage agar kompatibel dgn semua provider.
  const res = await model.invoke([new HumanMessage(prompt)]);
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return content.trim();
}

export async function buildInitialSummaryFromText(manualContext: string): Promise<string> {
  const prompt = `Berdasarkan deskripsi singkat berikut tentang seorang kontak WhatsApp:

"${manualContext}"

Hasilkan teks dengan format PERSIS berikut, dalam Bahasa Indonesia, tanpa komentar lain:

=== KONTEKS ===
[Uraikan ulang deskripsi di atas sebagai konteks: siapa orang ini, topik yang relevan]

=== STYLE BAHASA ===
[Karena belum ada data percakapan, sarankan style bahasa default yang sesuai dengan konteks: formal/informal, tone yang cocok]`;

  const model = await getActiveChatModel();
  // Gemini menolak request yang hanya berisi SystemMessage (contents kosong).
  // Kirim sebagai HumanMessage agar kompatibel dgn semua provider.
  const res = await model.invoke([new HumanMessage(prompt)]);
  const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
  return content.trim();
}
