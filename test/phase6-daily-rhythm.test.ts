import { describe, expect, it, vi } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { fakeToolCall } from "../src/model/fake-model.js";
import { FixedClock } from "../src/clock.js";
import { WakeupsRepo } from "../src/scheduler/wakeups-repo.js";
import { WakeupScheduler } from "../src/scheduler/wakeup-scheduler.js";
import { wallClockInZone } from "../src/scheduler/time-zones.js";
import { handleCron, HOURLY_CRON, NIGHTLY_CRON } from "../src/scheduler/cron.js";

describe("Phase 6: daily rhythm", () => {
  it("schedule_wakeup validates the instant and points the alarm at the earliest", async () => {
    const h = makeHarness([
      { content: "", toolCalls: [fakeToolCall("schedule_wakeup", { fire_at: "2026-09-27T11:00:00.000Z", reason: "essay due tomorrow" })] },
      { content: "Scheduled." },
    ]);
    await h.agent.handle(ownerEvent("remind me the night before my essay"));
    const all = await h.wakeups.list();
    expect(all.filter((w) => w.kind === "owner").map((w) => w.reason)).toEqual(["essay due tomorrow"]);
    // The live exchange also armed the quiet-conversation memory review (a system timer).
    expect(all.filter((w) => w.kind === "memory_review")).toHaveLength(1);
  });

  it("keeps the single alarm on the EARLIEST of several wake-ups", async () => {
    const clock = new FixedClock("2026-09-26T12:00:00.000Z");
    const alarm = vi.fn();
    const sched = new WakeupScheduler(new WakeupsRepo(clock), clock, alarm);
    await sched.schedule("2026-09-28T10:00:00.000Z", "later");
    await sched.schedule("2026-09-27T09:00:00.000Z", "sooner");
    expect(alarm).toHaveBeenLastCalledWith("2026-09-27T09:00:00.000Z");
    // Cancelling the earliest re-points the alarm at the next one.
    const earliestId = (await sched.earliest())!.id;
    await sched.cancel(earliestId);
    expect(alarm).toHaveBeenLastCalledWith("2026-09-28T10:00:00.000Z");
  });

  it("fires only wake-ups whose time has PASSED (assert which firing, not that one fires)", async () => {
    const clock = new FixedClock("2026-09-26T10:00:00.000Z");
    const sched = new WakeupScheduler(new WakeupsRepo(clock), clock);
    await sched.schedule("2026-09-26T11:00:00.000Z", "at 11");
    const fired: string[] = [];
    // At 10:00 nothing is due — must NOT fire an hour early.
    let n = await sched.fireDue(async (w) => void fired.push(w.reason));
    expect(n.fired).toBe(0);
    // At 11:00 it is due.
    clock.set("2026-09-26T11:00:00.000Z");
    n = await sched.fireDue(async (w) => void fired.push(w.reason));
    expect(n.fired).toBe(1);
    expect(fired).toEqual(["at 11"]);
  });

  it("resolves Eastern wall-clock with DST (same code, EST and EDT)", () => {
    // January: EST (UTC-5). 12:00Z -> 07:00.
    expect(wallClockInZone("2026-01-15T12:00:00.000Z", "America/Toronto").hour).toBe(7);
    // July: EDT (UTC-4). 12:00Z -> 08:00.
    expect(wallClockInZone("2026-07-15T12:00:00.000Z", "America/Toronto").hour).toBe(8);
  });

  it("the hourly cron fires due wake-ups, hands Jarvis an hourly check, pings the watchdog, beats", async () => {
    // Model, on the hourly check, decides to text Sid a digest.
    const h = makeHarness([
      { content: "" }, // (no due wake-up handling text)
      { content: "", toolCalls: [fakeToolCall("send_text", { message: "Morning digest: nothing urgent." })] },
      { content: "" },
    ]);
    await h.wakeups.schedule("2026-09-26T00:00:00.000Z", "past-due reminder"); // already due
    const res = await handleCron({
      cronExpr: HOURLY_CRON,
      agent: h.agent,
      scheduler: h.wakeups,
      heartbeat: h.heartbeat,
      watchdog: h.watchdog,
      backup: h.backup,
    });
    expect(res.wakeupsFired).toBe(1);
    expect(res.ran).toContain("hourly_check");
    // No watchdog URL configured -> honest not_connected, not a fake success.
    expect(res.watchdog!.ok).toBe(false);
    expect(res.watchdog!.status).toBe("not_connected");
    // Heartbeat recorded for this cron.
    expect(await h.heartbeat.last(`cron:${HOURLY_CRON}`)).toBeTruthy();
    // The model (not code) chose to send the digest.
    expect(h.ownerChannel.sent.some((m) => m.includes("digest"))).toBe(true);
  });

  it("the nightly cron runs the backup and not the hourly poll", async () => {
    const h = makeHarness([]);
    const res = await handleCron({
      cronExpr: NIGHTLY_CRON,
      agent: h.agent,
      scheduler: h.wakeups,
      heartbeat: h.heartbeat,
      watchdog: h.watchdog,
      backup: h.backup,
    });
    expect(res.ran).toEqual(["nightly_backup"]);
    expect(res.backupKey).toBeTruthy();
  });
});
