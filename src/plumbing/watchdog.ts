/**
 * External watchdog: the hourly run pings Healthchecks.io (or UptimeRobot). If
 * the pings stop, THAT service alerts Sid — it runs outside Cloudflare, so it
 * works even when Jarvis is down.
 *
 * HONESTY: with no ping URL configured, ping() returns not_connected, not a fake
 * success. A failed ping surfaces the real status.
 */
export class WatchdogPinger {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly url: string | undefined, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }
  async ping(): Promise<{ ok: boolean; status: string }> {
    if (!this.url || this.url.trim() === "") return { ok: false, status: "not_connected" };
    try {
      const res = await this.fetchImpl(this.url, { method: "GET" });
      return res.ok ? { ok: true, status: "ok" } : { ok: false, status: `http_${res.status}` };
    } catch (e) {
      return { ok: false, status: "network_error" };
    }
  }
}
