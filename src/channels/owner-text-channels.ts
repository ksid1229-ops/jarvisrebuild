import type { OwnerChannel, OwnerSendResult } from "../jarvis/tool-types.js";
import type { TextMedium } from "../types.js";

export type MediumSender = (message: string) => Promise<{ ok: boolean; status: string; detail?: string }>;

/**
 * Sid's text channels — Telegram and SMS — behind the one OwnerChannel the
 * brain uses (Sid, 2026-09-26: "both, one brain").
 *
 * Which medium a message goes on:
 *  1. `via`, when the caller names one: the model picks for send_text; code
 *     passes the current turn's medium for replies and confirmation requests.
 *  2. Otherwise (a confirmation raised from a wake-up, a pairing notice) the
 *     medium Sid last texted from — a recorded fact, not a guess.
 *  3. With no history, every configured medium, so nothing is silently lost.
 * The result always says which medium(s) were used.
 */
export class OwnerTextChannels implements OwnerChannel {
  constructor(
    private readonly media: Partial<Record<TextMedium, MediumSender>>,
    private readonly lastUsed: () => Promise<TextMedium | undefined>,
  ) {}

  available(): TextMedium[] {
    return (["telegram", "sms"] as const).filter((m) => this.media[m] !== undefined);
  }

  async sendText(message: string, via?: TextMedium): Promise<OwnerSendResult> {
    if (via) return this.sendOn(via, message);
    const last = await this.lastUsed();
    if (last && this.media[last]) {
      const r = await this.sendOn(last, message);
      return { ...r, detail: [r.detail, `sent on ${last}, the channel Sid last used`].filter(Boolean).join("; ") };
    }
    const avail = this.available();
    if (avail.length === 0) {
      return { ok: false, status: "not_connected", detail: "No text channel is configured (Telegram or SMS).", via: [] };
    }
    const results = await Promise.all(avail.map(async (m) => ({ m, r: await this.sendOn(m, message) })));
    const okOn = results.filter((x) => x.r.ok).map((x) => x.m);
    const failed = results.filter((x) => !x.r.ok);
    return {
      ok: okOn.length > 0,
      status: failed.length === 0 ? "ok" : okOn.length > 0 ? "partial" : failed[0]!.r.status,
      detail:
        `no channel used yet, so sent on every configured one` +
        (failed.length > 0 ? `; failed on ${failed.map((f) => `${f.m} (${f.r.status}: ${f.r.detail ?? ""})`).join(", ")}` : ""),
      via: okOn,
    };
  }

  private async sendOn(medium: TextMedium, message: string): Promise<OwnerSendResult> {
    const sender = this.media[medium];
    if (!sender) return { ok: false, status: "not_connected", detail: `${medium} is not set up.`, via: [] };
    const r = await sender(message);
    return { ...r, via: r.ok ? [medium] : [] };
  }
}
