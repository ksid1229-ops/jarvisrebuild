import { describe, expect, it } from "vitest";
import { makeHarness, ownerEvent } from "./helpers.js";
import { InMemoryPcJobsRepo } from "../src/pc/pc-jobs-repo.js";
import { InMemoryPcHeartbeatRepo } from "../src/pc/pc-tools.js";
import { FixedClock } from "../src/clock.js";
import { appEventFrom } from "../src/apps/app-events.js";

/**
 * Audit round 4 — every fix verified by a falsifier: each test names the
 * defect it kills. All 4 new guards were mutation-checked on 2026-09-26:
 * each defect planted back, the suite went red, the defect reverted.
 *
 * Claims verified against HEAD 1ad00bf first. pc_execute's missing
 * confirmation was WITHDRAWN by the auditor (src/pc/pc-tools.ts records it
 * as Sid's decision, 2026-09-26) — unchanged here, and the narrow question
 * is Sid's to answer. `pnpm run typecheck` failing with ?raw imports did
 * NOT reproduce: all three typecheck scripts pass at HEAD and no source
 * file imports ?raw. Real and fixed below: the open_url scheme gap (both
 * ends) and app events still carrying isOwner: true (the email wake was
 * already the honest precedent).
 */

// ---------------------------------------------------------------------------
// 1. open_url / browser jobs take WEB URLs only — Sid's real browser is in scope
// ---------------------------------------------------------------------------

function pcHarness() {
  const clock = new FixedClock("2026-09-26T12:00:00.000Z");
  return makeHarness([{ content: "x" }], {
    clock,
    stores: { pcJobs: new InMemoryPcJobsRepo(), pcHeartbeat: new InMemoryPcHeartbeatRepo(clock) },
  });
}

describe("audit 4: open_url and browser jobs take full web URLs only", () => {
  it("a file: URL is refused and nothing is queued — it would open a local file in Sid's browser", async () => {
    const h = pcHarness();
    const res = await h.dispatcher.dispatch(
      "pc_execute",
      { kind: "open_url", url: "file:///C:/Users/Sid/Documents/grades.xlsx" },
      h.ctxFor(ownerEvent("open my grades file", "e1")),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refused");
    expect(res.message ?? "").toContain("http");
    expect(await h.pcJobs!.pendingCount()).toBe(0);
  });

  it("the browser job refuses file: too (the Playwright runner would have driven Chrome to it)", async () => {
    const h = pcHarness();
    const res = await h.dispatcher.dispatch(
      "pc_execute",
      { kind: "browser", url: "file:///C:/Users/Sid/Documents/tax.html", instructions: "read it" },
      h.ctxFor(ownerEvent("read that page", "e1")),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refused");
    expect(await h.pcJobs!.pendingCount()).toBe(0);
  });

  it("a bare domain is refused with the honest reason — code does not guess a scheme", async () => {
    const h = pcHarness();
    const res = await h.dispatcher.dispatch(
      "pc_execute",
      { kind: "open_url", url: "d2l.limestone.on.ca/d2l/home" },
      h.ctxFor(ownerEvent("open d2l", "e1")),
    );
    expect(res.ok).toBe(false);
    expect(res.message ?? "").toContain("complete URL");
    expect(await h.pcJobs!.pendingCount()).toBe(0);
  });

  it("a full https URL still queues (the gate is not a block)", async () => {
    const h = pcHarness();
    const res = await h.dispatcher.dispatch(
      "pc_execute",
      { kind: "open_url", url: "https://d2l.limestone.on.ca/d2l/home" },
      h.ctxFor(ownerEvent("open d2l", "e1")),
    );
    expect(res.ok).toBe(true);
    expect(await h.pcJobs!.pendingCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. An app event is NOT the owner — the hard wire, not just the prompt label
// ---------------------------------------------------------------------------

describe("audit 4: an app event's provenance says isOwner: false", () => {
  it("the event wire carries isOwner false, sourceType app, and the app's name", () => {
    const ev = appEventFrom({
      id: "appevt_1",
      appName: "testapp",
      payloadJson: JSON.stringify({ n: 1 }),
      receivedAt: "2026-09-26T12:00:00.000Z",
    });
    expect(ev.trigger).toBe("app_event");
    expect(ev.provenance.isOwner).toBe(false);
    expect(ev.provenance.sourceType).toBe("app");
    expect(ev.provenance.sourceName).toBe("testapp");
    expect(ev.provenance.sourceRef).toContain("app:testapp");
  });
});
