// Ring buffer in-memory untuk merekam N webhook event terakhir yang
// masuk ke /webhook. Tujuannya bukan persistensi (server restart =
// log hilang), melainkan diagnostik cepat: user bisa lihat di
// dashboard apakah WAHA benar-benar mengirim event ke bot, dan kalau
// mengirim, kenapa pesannya di-skip atau gagal diproses.

export interface WebhookLogEntry {
  id: number;
  at: number;
  remoteIp?: string;
  decision: string;
  extracted: {
    from: string | null;
    text: string;
    fromMe: boolean;
    notifyName?: string;
  };
  raw: unknown;
}

const RING_SIZE = 50;
const buffer: WebhookLogEntry[] = [];
let counter = 0;

export function recordWebhookEvent(
  entry: Omit<WebhookLogEntry, "id" | "at"> & { at?: number },
): void {
  counter += 1;
  const e: WebhookLogEntry = {
    id: counter,
    at: entry.at ?? Date.now(),
    remoteIp: entry.remoteIp,
    decision: entry.decision,
    extracted: entry.extracted,
    raw: entry.raw,
  };
  buffer.push(e);
  if (buffer.length > RING_SIZE) buffer.shift();
}

export function getWebhookLog(): WebhookLogEntry[] {
  return [...buffer].reverse();
}

export function clearWebhookLog(): void {
  buffer.length = 0;
}
