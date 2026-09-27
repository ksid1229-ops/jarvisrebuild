import type { OwnerChannel } from "../jarvis/tool-types.js";

/**
 * A fake owner channel for tests and local runs. It records every send so a
 * test can assert what Sid actually received. It can be told to FAIL, to prove
 * that a failed send is surfaced (not swallowed) — brief HONESTY rule.
 */
export class FakeOwnerChannel implements OwnerChannel {
  public readonly sent: string[] = [];
  /** The `via` each send asked for (undefined = the channel chose). */
  public readonly sentVia: (string | undefined)[] = [];
  public failNext = false;

  async sendText(message: string, via?: import("../types.js").TextMedium): Promise<{ ok: boolean; status: string; detail?: string }> {
    this.sentVia.push(via);
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, status: "send_failed", detail: "fake channel was told to fail" };
    }
    this.sent.push(message);
    return { ok: true, status: "ok" };
  }
}
