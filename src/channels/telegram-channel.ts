import type { OwnerChannel } from "../jarvis/tool-types.js";

/**
 * Real Telegram owner channel over the Bot API. Delivery status is surfaced —
 * a non-200 from Telegram or a network error is returned as ok:false, never
 * swallowed into a fake success.
 *
 * Trap #1: fetch is bound to globalThis to avoid "Illegal invocation" in prod.
 */
export class TelegramChannel implements OwnerChannel {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    fetchImpl?: typeof fetch,
    private readonly timeoutMs = TELEGRAM_TIMEOUT_MS,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Send a message. Telegram rejects any single message over 4096 characters,
   * so a longer one goes out as several consecutive messages, split at a line
   * break or space where possible. If a part fails, sending stops there and the
   * result says exactly how many parts arrived — never a fake success.
   */
  async sendText(message: string): Promise<{ ok: boolean; status: string; detail?: string }> {
    if (!this.botToken) return { ok: false, status: "not_connected", detail: "TELEGRAM_BOT_TOKEN unset" };
    const parts = splitForTelegram(message);
    for (let i = 0; i < parts.length; i++) {
      const sent = await this.sendOne(parts[i]!);
      if (!sent.ok) {
        const where = parts.length > 1 ? ` (part ${i + 1} of ${parts.length}; ${i} part(s) delivered before it)` : "";
        return { ok: false, status: sent.status, detail: `${sent.detail ?? ""}${where}`.trim() };
      }
    }
    return { ok: true, status: "ok", ...(parts.length > 1 ? { detail: `sent as ${parts.length} messages` } : {}) };
  }

  private async sendOne(text: string): Promise<{ ok: boolean; status: string; detail?: string }> {
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text }),
        // Audit round 3: this sits on every turn's reply path — a hung Telegram
        // connection must not hang the turn with it.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, status: `telegram_${res.status}`, detail: body.slice(0, 300) };
      }
      return { ok: true, status: "ok" };
    } catch (e) {
      if ((e as Error).name === "TimeoutError") {
        return { ok: false, status: "timeout", detail: `Telegram did not answer within ${this.timeoutMs}ms` };
      }
      return { ok: false, status: "network_error", detail: (e as Error).message };
    }
  }
}

/** Telegram's per-message limit (characters, counted as UTF-16 units). */
export const TELEGRAM_MAX_MESSAGE = 4096;

/** How long a single Telegram API call may hang before the turn gives up on it. */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * Split text into parts no longer than `max`, preferring a line break, then a
 * space, in the back half of each window; otherwise a hard cut that never
 * separates a surrogate pair. Joining the parts reproduces the original text.
 */
export function splitForTelegram(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 2) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // keep a surrogate pair together
    } else {
      cut += 1; // keep the separator on the earlier part so nothing is lost
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
