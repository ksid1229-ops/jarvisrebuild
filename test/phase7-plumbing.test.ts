import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { FixedClock } from "../src/clock.js";
import { InMemoryBucket } from "../src/plumbing/bucket.js";
import { ArchiveService, archiveSearch } from "../src/plumbing/archive.js";
import { buildVaultExport, authorizeVaultExport } from "../src/plumbing/vault.js";
import { WatchdogPinger } from "../src/plumbing/watchdog.js";

function seedFacts(h: ReturnType<typeof makeHarness>, n: number) {
  for (let i = 0; i < n; i++) {
    h.facts.save({
      text: `fact number ${i}`,
      kind: "durable",
      confidence: "inferred",
      sourceType: "conversation",
      sourceRef: "x",
      expiresAt: null,
    });
  }
}

describe("Phase 7: plumbing", () => {
  it("nightly backup exports every table AND every row (no silent truncation)", async () => {
    const h = makeHarness([]);
    seedFacts(h, 100);
    const { key, counts } = await h.backup.exportAll();
    expect(key).toContain("backups/");
    expect(counts.facts).toBe(100);
    // The stored blob really contains all 100 rows.
    const blob = await h.bucket.get(key);
    const parsed = JSON.parse(blob!);
    expect(parsed.tables.facts).toHaveLength(100);
    expect(Object.keys(parsed.tables)).toEqual(
      expect.arrayContaining(["facts", "wakeups", "guests", "connected_apps", "receipts", "settings"]),
    );
  });

  it("archive stores conversation by date and searches across the range", async () => {
    const clock = new FixedClock("2026-09-26T12:00:00.000Z");
    const archive = new ArchiveService(new InMemoryBucket(), clock);
    await archive.append({ role: "user", content: "I hate mornings", channel: "text" });
    await archive.append({ role: "assistant", content: "Noted about mornings.", channel: "voice" });
    const { results } = await archive.search("mornings");
    expect(results).toHaveLength(2);
    // Includes a call transcript (channel voice).
    expect(results.some((r) => r.channel === "voice")).toBe(true);
  });

  it("archive_search tool returns matches through the context", async () => {
    const h = makeHarness([]);
    await h.archive.append({ role: "user", content: "essay due Friday", channel: "text" });
    const ctx = h.ctxFor(ownerEvent("find essay", "e1"));
    const res = await archiveSearch.run({ query: "essay" }, ctx);
    expect(res.ok).toBe(true);
    expect(((res.data as any).results as any[]).length).toBe(1);
  });

  it("heartbeat distinguishes alive from quiet", () => {
    const h = makeHarness([]);
    h.heartbeat.record("cron");
    expect(h.heartbeat.last("cron")).toBeTruthy();
    expect(h.heartbeat.last("never-run")).toBeUndefined();
  });

  it("watchdog pings when configured and is honest (not fake) when not", async () => {
    const off = new WatchdogPinger(undefined);
    expect((await off.ping()).status).toBe("not_connected");

    const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const on = new WatchdogPinger("https://hc-ping.com/abc", fakeFetch);
    expect((await on.ping()).ok).toBe(true);
  });

  it("vault export processes EVERY note (the first build stopped at 64)", () => {
    const h = makeHarness([]);
    seedFacts(h, 100);
    h.wakeups.schedule("2026-09-27T10:00:00.000Z", "a reminder");
    const exported = buildVaultExport(h.facts.all(), h.wakeupsRepo.list());
    expect(exported.count).toBe(101); // 100 facts + 1 wakeup, NOT capped at 64
    expect(exported.notes[0]!.markdown).toContain("---"); // frontmatter
  });

  it("vault export is token-gated and fails closed with no configured token", () => {
    expect(authorizeVaultExport("secret", "secret")).toBe(true);
    expect(authorizeVaultExport("wrong", "secret")).toBe(false);
    expect(authorizeVaultExport("secret", undefined)).toBe(false); // fail closed
    expect(authorizeVaultExport(null, "secret")).toBe(false);
  });
});
