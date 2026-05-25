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

export async function getEffectiveSystemPrompt(waNumber: string): Promise<string> {
  const entry = await getWhitelistEntry(waNumber);
  if (entry?.role) return entry.role.systemPrompt;
  const def = await prisma.aiRole.findFirst({
    where: { isDefault: true },
    orderBy: { createdAt: "desc" },
  });
  if (def) return def.systemPrompt;
  return "Kamu adalah asisten WhatsApp yang ramah, ringkas, dan menjawab dalam Bahasa Indonesia.";
}
