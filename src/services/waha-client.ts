import { request } from "undici";

const WAHA_URL = (process.env.WAHA_URL || "http://localhost:3001").replace(/\/$/, "");
const WAHA_API_KEY = process.env.WAHA_API_KEY || "";
const WAHA_SESSION = process.env.WAHA_SESSION || "default";

function buildHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (WAHA_API_KEY) h["X-Api-Key"] = WAHA_API_KEY;
  return h;
}

function toChatId(waNumber: string): string {
  const n = waNumber.replace(/@.*/g, "").replace(/\D/g, "");
  return `${n}@c.us`;
}

export async function sendText(waNumber: string, text: string): Promise<void> {
  const url = `${WAHA_URL}/api/sendText`;
  const body = {
    session: WAHA_SESSION,
    chatId: toChatId(waNumber),
    text,
  };

  const res = await request(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  if (res.statusCode >= 400) {
    const txt = await res.body.text();
    throw new Error(`WAHA sendText gagal (${res.statusCode}): ${txt}`);
  } else {
    await res.body.dump();
  }
}

export async function startTyping(waNumber: string): Promise<void> {
  try {
    await request(`${WAHA_URL}/api/startTyping`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        session: WAHA_SESSION,
        chatId: toChatId(waNumber),
      }),
    }).then((r) => r.body.dump());
  } catch {
    // typing indikator opsional — jangan throw
  }
}
