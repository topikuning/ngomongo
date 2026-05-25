import { prisma } from "../lib/prisma.js";

export function normalizeNumber(raw: string): string {
  // Buang semua karakter selain digit, hilangkan suffix @c.us / @s.whatsapp.net
  return raw.replace(/@.*/g, "").replace(/\D/g, "");
}

export async function isWhitelisted(waNumber: string): Promise<boolean> {
  const n = normalizeNumber(waNumber);
  if (!n) return false;
  const found = await prisma.whitelistedNumber.findFirst({
    where: { waNumber: n, isActive: true },
    select: { id: true },
  });
  return !!found;
}

export async function getWhitelistEntry(waNumber: string) {
  const n = normalizeNumber(waNumber);
  return prisma.whitelistedNumber.findUnique({
    where: { waNumber: n },
    include: { role: true },
  });
}

export async function ensureUser(waNumber: string, displayName?: string) {
  const n = normalizeNumber(waNumber);
  return prisma.user.upsert({
    where: { waNumber: n },
    update: displayName ? { displayName } : {},
    create: { waNumber: n, displayName: displayName || null },
  });
}

const FALLBACK_SYSTEM_PROMPT =
  "Kamu sedang chat lewat WhatsApp dengan seorang kenalan. Balas natural seperti manusia ngobrol biasa, sesuai konteks percakapan. Jangan terdengar seperti AI atau asisten — tidak pakai disclaimer kaku, tidak pakai bullet/list di pesan biasa, tidak echoing peran.";

export async function getEffectiveSystemPrompt(waNumber: string): Promise<string> {
  const entry = await getWhitelistEntry(waNumber);
  // 1. systemPrompt per nomor (sumber utama setelah migrasi role-per-number)
  if (entry?.systemPrompt && entry.systemPrompt.trim().length > 0) {
    return entry.systemPrompt;
  }
  // 2. Backward compat: role lama yang masih ke-link via roleId
  if (entry?.role) return entry.role.systemPrompt;
  // 3. Fallback netral — tidak ada role-CS-style
  return FALLBACK_SYSTEM_PROMPT;
}
