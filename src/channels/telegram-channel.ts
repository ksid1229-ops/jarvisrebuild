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
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async sendText(message: string): Promise<{ ok: boolean; status: string; detail?: string }> {
    if (!this.botToken) return { ok: false, status: "not_connected", detail: "TELEGRAM_BOT_TOKEN unset" };
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: message }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, status: `telegram_${res.status}`, detail: body.slice(0, 300) };
      }
      return { ok: true, status: "ok" };
    } catch (e) {
      return { ok: false, status: "network_error", detail: (e as Error).message };
    }
  }
}
