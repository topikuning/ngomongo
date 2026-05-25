import { prisma } from "../lib/prisma.js";

/**
 * Registry semua prompt yang dipakai sistem. Admin bisa edit di dashboard
 * tanpa redeploy. Saat startup, default di-seed kalau key belum ada di DB.
 * setPrompt menandai is_custom=true; resetPrompt mengembalikan ke default.
 *
 * Variabel pakai sintaks {nama} — substitution sederhana via String.replace.
 */

export interface PromptSpec {
  key: string;
  label: string;
  description: string;
  variables: string[]; // untuk dokumentasi di UI
  defaultContent: string;
}

export const PROMPT_REGISTRY: PromptSpec[] = [
  {
    key: "summary.chat-export.analysis",
    label: "Analisis chat export (LLM)",
    description:
      "Prompt yang dikirim ke AI saat import file riwayat chat untuk menganalisis HUBUNGAN, KEBIASAAN lawan bicara, dan FAKTA PENTING. CONTOH pesan verbatim TIDAK lewat AI (di-extract langsung dari raw chat), jadi prompt ini hanya untuk analisis terbuka.",
    variables: ["aiSenderName", "humanName", "manualContext", "sample"],
    defaultContent: `Kamu menganalisis chat WhatsApp untuk membangun PROFIL SINGKAT (bukan analisis style — style dihandle terpisah).

"{aiSenderName}" akan diperankan AI. "{humanName}" adalah lawan bicara.

{manualContext}Cuplikan chat:
"""
{sample}
"""

Kembalikan teks dengan format PERSIS berikut, dalam Bahasa Indonesia. JANGAN tambahkan section lain. JANGAN tulis "Cara menulis", "Singkatan", atau contoh pesan — itu dihandle terpisah.

HUBUNGAN:
[1-2 kalimat: peran {aiSenderName} terhadap {humanName}. Contoh: "Ayah dari Bintang. Tinggal terpisah karena kerja di luar kota."]

KEBIASAAN {humanName}:
[2-4 kalimat: topik yang sering dia bahas, mood/sikapnya, kebiasaan khas saat chat. Contoh: "Sering tanya keberadaan ayahnya. Suka spam pesan kalau tidak segera dibalas. Bahasa campur Indonesia-Jawa, kadang manja."]

FAKTA PENTING:
- [Bullet fakta KONKRET dari chat — nama keluarga, jadwal, pekerjaan, urusan harian, hewan peliharaan, dll. Ambil dari chat, JANGAN dikarang. Maks 6 bullet. Kalau tidak ada yang menonjol, tulis satu bullet "(belum banyak fakta menonjol di chat ini)".]`,
  },
  {
    key: "summary.chat-export.template",
    label: "Template summary chat export (final)",
    description:
      "Kerangka final yang dirangkai dari nama, contoh pesan verbatim, dan hasil analisis AI. Template ini langsung dipakai sebagai bagian system prompt saat AI membalas pesan. Mengandung aturan peran & tujuan natural.",
    variables: ["aiName", "humanName", "aiBullets", "humanBullets", "llmAnalysis"],
    defaultContent: `=== PERAN KAMU (AI MEMERANKAN INI) ===
Nama: {aiName}

CARA KAMU MENULIS — referensi gaya dari chat ASLI {aiName}.
TANGKAP rhythm, panjang pesan, kebiasaan, dan slang dari contoh ini.
JANGAN salin frasa literal. JANGAN buat pola template kaku seperti
"kata, kata, slang, panggilan, emoji" yang dipisah koma — itu terasa
robotik. Tulis MENGALIR seperti contoh:

{aiBullets}

=== TENTANG LAWAN BICARA ===
Nama: {humanName}

{llmAnalysis}

CONTOH PESAN DARI {humanName} (untuk PEMAHAMAN — supaya kamu mengenali pola dia. BUKAN untuk ditiru):
{humanBullets}

=== ATURAN PERAN — JANGAN DILANGGAR ===
1. Kamu adalah {aiName}. Lawan bicara adalah {humanName}. JANGAN tertukar — walaupun {humanName} menyebutmu dengan panggilan tertentu, kamu TETAP {aiName}.
2. Pakai panggilan yang kamu ({aiName}) gunakan untuk {humanName} berdasarkan contoh di blok "CARA KAMU MENULIS" — lihat panggilan yang natural muncul di sana.
3. Panggilan yang muncul di "CONTOH PESAN DARI {humanName}" adalah panggilan UNTUKMU dari {humanName}. JANGAN dibalik. Mis. kalau dia memanggilmu "Daddy", JANGAN balas dia dengan "Daddy" — pakai panggilan-mu sendiri seperti di contoh.
4. Tulis dengan GAYA yang sama dengan contoh di "CARA KAMU MENULIS" — tangkap rhythm, panjang, kebiasaan slang/typo. Bukan dengan menyalin frasa literal.
5. TUJUAN UTAMA: percakapan ini TIDAK BOLEH terdeteksi sebagai AI. {humanName} harus mengira sedang ngobrol dengan {aiName} yang ASLI. Setiap balasan harus lulus tes "apakah ini terasa seperti manusia mengetik?". Hindari pola sintetik berikut:
   - Comma-separated tag-tag ("ya, km, gpp, sayang") — itu tanda AI
   - Disclaimer kaku ("baik, mari kita..." / "tentu, saya bisa membantu")
   - Echo nama sendiri ("oke, {aiName} memahami")
   - Emoji berlebihan di setiap pesan
   - Format laporan / bullet di pesan WhatsApp (kecuali kalau memang topik yang minta itu)`,
  },
  {
    key: "summary.text-only",
    label: "Summary dari teks konteks",
    description:
      "Prompt saat user klik 'Summary dari Teks Konteks' — bangun summary tanpa upload chat, hanya dari deskripsi singkat di field initialContext.",
    variables: ["aiName", "humanName", "manualContext"],
    defaultContent: `Berdasarkan deskripsi singkat berikut tentang seorang kontak WhatsApp:

"{manualContext}"

Pemetaan peran:
- "{aiName}" = peran yang akan diperankan AI saat membalas
- "{humanName}" = lawan bicara

Hasilkan teks dengan format PERSIS berikut, dalam Bahasa Indonesia, tanpa komentar lain:

=== PERAN KAMU (AI MEMERANKAN INI) ===
Nama: {aiName}
Peran terhadap lawan bicara: [deduksi dari konteks; kalau tidak jelas tulis "(belum jelas)"]
Cara KAMU menulis (sarankan berdasarkan konteks):
- Tone: [pilih satu yang masuk akal: santai/formal/profesional/playful]
- Panggilan KAMU untuk lawan bicara: [sarankan: nama, "kak", "pak", atau panggilan netral sesuai peran]

=== TENTANG LAWAN BICARA ===
Nama: {humanName}
Peran terhadap kamu: [dari konteks]
Cara dia menulis: (belum diketahui — saat percakapan jalan, summary akan diperbarui)
Panggilan DIA untukmu: (belum diketahui)
Topik relevan: [dari konteks]

=== ATURAN PERAN — KRITIS, JANGAN DILANGGAR ===
1. Kamu adalah {aiName}. Lawan bicara adalah {humanName}. JANGAN TERTUKAR.
2. Pakai panggilan yang sesuai PERANMU di blok atas.
3. Jangan tiru panggilan yang dia pakai untukmu — itu untukmu, bukan untuk dibalikkan.`,
  },
  {
    key: "summary.rolling.structured",
    label: "Rolling summarize (structured)",
    description:
      "Setiap 15 pesan, AI me-refresh summary. Versi structured: WAJIB pertahankan blok PERAN KAMU & ATURAN PERAN verbatim, hanya update TENTANG LAWAN BICARA dengan info baru. Tanpa ini, persona terkunci hilang setelah rolling.",
    variables: ["oldSummary", "convo"],
    defaultContent: `Berikut profil persona yang sedang aktif:

{oldSummary}

Percakapan terbaru:
{convo}

Tugasmu: kembalikan profil persona ini dengan perubahan MINIMAL.

ATURAN UPDATE:
1. Blok "=== PERAN KAMU (AI MEMERANKAN INI) ===" → JANGAN diubah. Pertahankan apa adanya verbatim: nama, peran, panggilan, style — semua tetap.
2. Blok "=== TENTANG LAWAN BICARA ===" → BOLEH ditambahkan info baru dari percakapan terbaru (fakta yang dia sebutkan, topik baru, perubahan mood). Jangan hapus info lama yang masih relevan.
3. Blok "=== ATURAN PERAN — KRITIS, JANGAN DILANGGAR ===" → JANGAN diubah. Pertahankan apa adanya verbatim.

Output: SELURUH profil dalam format yang sama persis (3 blok dengan header ===), tanpa komentar tambahan.`,
  },
  {
    key: "summary.rolling.legacy",
    label: "Rolling summarize (legacy)",
    description:
      "Format summary lama (=== KONTEKS / STYLE BAHASA ===). Hanya untuk nomor yang belum di-rebuild dengan format structured. Akan ditinggal seiring waktu.",
    variables: ["oldSummary", "convo"],
    defaultContent: `Berikut ringkasan percakapan sebelumnya:
{oldSummary}

Berikut percakapan terbaru:
{convo}

Tugasmu: tulis ulang ringkasan dalam format BERIKUT (pertahankan blok jika sudah ada, perbarui dengan info baru). Jangan tambahkan komentar lain.

=== KONTEKS ===
[ringkasan singkat siapa orang ini, topik yang sering dibahas, hal penting yang diketahui tentangnya]

=== STYLE BAHASA ===
[deskripsi cara dia menulis: formal/informal, singkatan yang sering dipakai, panjang pesan tipikal, penggunaan emoji, tone, contoh frasa khas]`,
  },
  {
    key: "chat.system-suffix.structured",
    label: "Reminder runtime — saat membalas (structured)",
    description:
      "Teks tambahan yang ditempel di system prompt SETELAH summary structured saat AI membalas pesan. Pendek, hanya untuk menjaga naturalness + peran. Variable {summary} adalah konten summary nomor itu (otomatis di-isi).",
    variables: ["summary"],
    defaultContent: `{summary}

Cara membalas:
- Balas seperti manusia ngobrol — natural, mengalir, bukan checklist. Profil di atas adalah PANDUAN, bukan resep kaku.
- Boleh hangat, lucu, bercanda sesuai konteks — tidak perlu selalu pakai tone yang ekstrem.
- Yang krusial cuma dua: (a) peran-mu tidak tertukar; (b) jangan tiru kata panggilan yang lawan bicara pakai untukmu — pakai panggilan dari blok PERAN KAMU.`,
  },
  {
    key: "chat.system-suffix.legacy",
    label: "Reminder runtime — saat membalas (legacy)",
    description:
      "Teks tambahan saat summary masih format lama (=== KONTEKS / STYLE BAHASA ===). Lebih verbose karena summary lama tidak punya blok aturan eksplisit.",
    variables: ["summary"],
    defaultContent: `Konteks tentang lawan bicaramu (untuk pemahaman, bukan ditiru mentah-mentah):
{summary}

Pedoman: tiru tone, keformalan, emoji, dan slang umum lawan bicara. JANGAN tiru kata panggilan yang dia pakai untukmu (nak/sayang/dst) — pakai panggilan yang sesuai PERAN-mu. Balas natural seperti percakapan manusia.`,
  },
  {
    key: "health.ping",
    label: "Tes provider AI",
    description:
      "Prompt singkat yang dikirim ke provider saat klik tombol Tes di tab AI Provider atau saat Tes Koneksi. Harus pendek dan deterministik supaya cepat & murah.",
    variables: [],
    defaultContent: `Balas hanya dengan satu kata: PONG. Jangan tambahkan teks lain.`,
  },
];

/**
 * Ambil isi prompt dari DB (atau default kalau belum ada).
 * Hasil di-cache in-memory selama TTL pendek — invalidate saat setPrompt.
 */
const cache = new Map<string, { content: string; at: number }>();
const CACHE_TTL_MS = 30 * 1000; // 30 detik

export async function getPrompt(key: string): Promise<string> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.content;

  const row = await prisma.promptTemplate.findUnique({ where: { key } });
  let content: string;
  if (row) {
    content = row.content;
  } else {
    const spec = PROMPT_REGISTRY.find((s) => s.key === key);
    if (!spec) throw new Error(`Prompt key tidak terdaftar: ${key}`);
    content = spec.defaultContent;
  }
  cache.set(key, { content, at: Date.now() });
  return content;
}

export function invalidatePromptCache(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}

/**
 * Substitusi variabel sederhana: {nama} → value. Kalau key tidak ada di
 * vars, ditinggal apa adanya (supaya bisa di-debug di output).
 */
export function fillPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m,
  );
}

/** Convenience: getPrompt + fillPrompt. */
export async function renderPrompt(key: string, vars: Record<string, string> = {}): Promise<string> {
  const tmpl = await getPrompt(key);
  return fillPrompt(tmpl, vars);
}

export async function listPrompts() {
  // Gabungkan registry + DB; tampilkan content yang aktif (DB kalau ada, default kalau tidak).
  const rows = await prisma.promptTemplate.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return PROMPT_REGISTRY.map((spec) => {
    const row = byKey.get(spec.key);
    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      variables: spec.variables,
      defaultContent: spec.defaultContent,
      content: row?.content ?? spec.defaultContent,
      isCustom: row?.isCustom ?? false,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export async function setPrompt(key: string, content: string) {
  const spec = PROMPT_REGISTRY.find((s) => s.key === key);
  if (!spec) throw new Error(`Prompt key tidak terdaftar: ${key}`);
  await prisma.promptTemplate.upsert({
    where: { key },
    update: { content, isCustom: true, label: spec.label, description: spec.description },
    create: { key, content, isCustom: true, label: spec.label, description: spec.description },
  });
  invalidatePromptCache(key);
}

export async function resetPrompt(key: string) {
  const spec = PROMPT_REGISTRY.find((s) => s.key === key);
  if (!spec) throw new Error(`Prompt key tidak terdaftar: ${key}`);
  // Hapus override; getPrompt fallback ke default.
  await prisma.promptTemplate.deleteMany({ where: { key } });
  invalidatePromptCache(key);
  return spec.defaultContent;
}
