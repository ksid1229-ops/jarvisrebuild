/**
 * School routes + extractors + school tools, end to end over real SQLite.
 * Batches are built from the School Helper app's own D2L fixtures, so the
 * extractors are tested against true D2L shapes — not hand-made lookalikes.
 */
import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import { buildVaultExport } from "../src/plumbing/vault.js";
import { canonical } from "../src/school/canonical.js";
import { parseSchoolBatch } from "../src/school/collector-protocol.js";
import { diffExtracted, extractEvidence } from "../src/school/evidence-items.js";
import { COLLECTOR_ENVELOPE_HEADER, handleSchoolRequest, type SchoolRouteDeps } from "../src/school/routes.js";
import {
  schoolChangesSince,
  schoolVaultSnapshot,
  schoolCollectorApprove,
  schoolCollectorRevoke,
  schoolD2lStatus,
  schoolItemOpen,
  schoolSnapshotRead,
  schoolSyncRequest,
} from "../src/school/school-tools.js";
import { SchoolRequests } from "../src/school/school-requests.js";
import { freshDb } from "./d1-testkit.js";
import { genKeypair, publicKeyB64, signEnvelope } from "./school-testkit.js";
import { makeHarness, ownerEvent } from "./helpers.js";
import folders from "../apps/school-helper/src/d2l/fixtures/dropbox-folders.json";
import submissions from "../apps/school-helper/src/d2l/fixtures/dropbox-submissions.json";
import grades from "../apps/school-helper/src/d2l/fixtures/grades.json";
import news from "../apps/school-helper/src/d2l/fixtures/news.json";
import quizzes from "../apps/school-helper/src/d2l/fixtures/quizzes.json";
import contentRoot from "../apps/school-helper/src/d2l/fixtures/content-root.json";
import enrollments from "../apps/school-helper/src/d2l/fixtures/enrollments.json";

const COURSE_ID = "29940528";
const COURSE_NAME = "BBB4M0-01 International Business";
const P = `/d2l/api/le/1.82/${COURSE_ID}`;
const STARTED = "2026-09-26T18:59:00.000Z";
const FETCHED = "2026-09-26T18:59:30.000Z";

function route(route: string, body: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { route, status: 200, fetchedAt: FETCHED, complete: true, body, ...extra };
}

function fixtureBatch(readId: string, opts: {
  due?: string;
  newsItems?: unknown[];
  submissions?: unknown[];
} = {}): Record<string, unknown> {
  const folderList = structuredClone(folders) as Record<string, unknown>[];
  if (opts.due !== undefined) {
    const first = folderList[0];
    if (!first) throw new Error("empty folders fixture");
    first.DueDate = opts.due;
  }
  return {
    schemaVersion: "1.0",
    host: "ldsb.elearningontario.ca",
    readId,
    startedAt: STARTED,
    courseIds: [COURSE_ID],
    enrollmentComplete: true,
    course: { id: COURSE_ID, name: COURSE_NAME },
    routes: [
      route(`${P}/dropbox/folders/`, folderList),
      route(`${P}/dropbox/folders/550012/submissions/mysubmissions/`, opts.submissions ?? submissions.slice(0, 1)),
      route(`${P}/grades/`, grades.objects),
      route(`${P}/grades/values/myGradeValues/`, grades.values),
      route(`${P}/news/`, opts.newsItems ?? news),
      route(`${P}/quizzes/`, quizzes),
      route(`${P}/content/toc`, contentRoot),
    ],
  };
}

function hostFailureBatch(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    host: "ldsb.elearningontario.ca",
    readId: "read-hostfail",
    startedAt: STARTED,
    courseIds: [],
    enrollmentComplete: false,
    course: null,
    routes: [
      route("/d2l/api/versions/", []),
      route("/d2l/api/lp/1.43/enrollments/myenrollments/", enrollments),
    ],
  };
}

async function startPairing(deps: SchoolRouteDeps, label = "Sid's Laptop"): Promise<{
  keys: CryptoKeyPair; collectorId: string; challenge: string; code: string;
}> {
  const keys = await genKeypair();
  const body = canonical({ publicKeyBase64: await publicKeyB64(keys), deviceLabel: label });
  const res = await handleSchoolRequest("POST", "/school/pairing/start", new Headers(), body, deps);
  if (res.status !== 200) throw new Error(`start failed: ${JSON.stringify(res.body)}`);
  const b = res.body as Record<string, string>;
  return { keys, collectorId: b.collectorId as string, challenge: b.challenge as string, code: b.code as string };
}

async function signed(
  deps: SchoolRouteDeps, path: string, keys: CryptoKeyPair, collectorId: string,
  body: string, issuedAt: string,
): Promise<{ status: number; body: unknown }> {
  const envelope = await signEnvelope({
    path, body, keys, deviceId: collectorId, principalId: deps.ownerId, issuedAt,
  });
  const headers = new Headers({ [COLLECTOR_ENVELOPE_HEADER]: JSON.stringify(envelope) });
  return handleSchoolRequest("POST", path, headers, body, deps);
}

function depsFor(clock: FixedClock): SchoolRouteDeps {
  return { db: freshDb(), ownerId: "sid", nowMs: () => clock.nowMs() };
}

describe("school pairing routes", () => {
  it("runs start → prove → status → approve → status → prove-again", async () => {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const h = makeHarness([], { clock, db: deps.db });
    const ctx = h.ctxFor(ownerEvent("pair the laptop"));

    const started = await startPairing(deps);
    expect(started.collectorId.startsWith("col_")).toBe(true);
    expect(started.code).toMatch(/^\d{3}-\d{3}$/);

    const proveBody = canonical({ challenge: started.challenge });
    const prove = await signed(deps, "/school/pairing/prove", started.keys, started.collectorId, proveBody, clock.nowIso());
    expect(prove.status).toBe(200);

    const statusBody = canonical({});
    const pending = await signed(deps, "/school/pairing/status", started.keys, started.collectorId, statusBody, clock.nowIso());
    expect(pending).toMatchObject({ status: 200, body: { status: "pending" } });

    const approval = await schoolCollectorApprove.run({ pairing_code: started.code }, ctx);
    expect(approval.ok).toBe(true);

    const active = await signed(deps, "/school/pairing/status", started.keys, started.collectorId, statusBody, clock.nowIso());
    expect(active).toMatchObject({ status: 200, body: { status: "active" } });

    // Retry-after-approval: prove still verifies on the active key.
    const proveAgain = await signed(deps, "/school/pairing/prove", started.keys, started.collectorId, proveBody, clock.nowIso());
    expect(proveAgain.status).toBe(200);
  });

  it("refuses bad start bodies, wrong challenges, replays and revoked keys", async () => {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const h = makeHarness([], { clock, db: deps.db });
    const ctx = h.ctxFor(ownerEvent("pairing attacks"));

    const badKey = await handleSchoolRequest("POST", "/school/pairing/start", new Headers(),
      canonical({ publicKeyBase64: "not-base64!!", deviceLabel: "x" }), deps);
    expect(badKey.status).toBe(400);
    const badLabel = await handleSchoolRequest("POST", "/school/pairing/start", new Headers(),
      canonical({ publicKeyBase64: await publicKeyB64(await genKeypair()), deviceLabel: "" }), deps);
    expect(badLabel.status).toBe(400);

    const started = await startPairing(deps);
    const wrong = await signed(deps, "/school/pairing/prove", started.keys, started.collectorId,
      canonical({ challenge: "wrong" }), clock.nowIso());
    expect(wrong.status).toBe(401);

    // Replay: the same signed bytes twice. The second dies on the nonce.
    const proveBody = canonical({ challenge: started.challenge });
    const envelope = await signEnvelope({
      path: "/school/pairing/prove", body: proveBody, keys: started.keys,
      deviceId: started.collectorId, principalId: "sid", issuedAt: clock.nowIso(),
    });
    const headers = new Headers({ [COLLECTOR_ENVELOPE_HEADER]: JSON.stringify(envelope) });
    const first = await handleSchoolRequest("POST", "/school/pairing/prove", headers, proveBody, deps);
    expect(first.status).toBe(200);
    const replay = await handleSchoolRequest("POST", "/school/pairing/prove", headers, proveBody, deps);
    expect(replay.status).toBe(409);

    // Revoke: the device is dead everywhere.
    await schoolCollectorApprove.run({ pairing_code: started.code }, ctx);
    const revoked = await schoolCollectorRevoke.run({ collector_id: started.collectorId }, ctx);
    expect(revoked.ok).toBe(true);
    const after = await signed(deps, "/school/pairing/status", started.keys, started.collectorId,
      canonical({}), clock.nowIso());
    expect(after.status).toBe(403);
    const unknownRevoke = await schoolCollectorRevoke.run({ collector_id: "col_nope" }, ctx);
    expect(unknownRevoke.ok).toBe(false);
  });

  it("expires pending pairings and rejects unknown devices, GETs and bad paths", async () => {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const started = await startPairing(deps);
    clock.advance(11 * 60 * 1000);
    const expired = await signed(deps, "/school/pairing/status", started.keys, started.collectorId,
      canonical({}), clock.nowIso());
    expect(expired.status).toBe(410);

    const stranger = await genKeypair();
    const unknown = await signed(deps, "/school/pairing/status", stranger, "col_stranger",
      canonical({}), clock.nowIso());
    expect(unknown.status).toBe(403);

    const get = await handleSchoolRequest("GET", "/school/pairing/status", new Headers(), "", deps);
    expect(get.status).toBe(405);
    const badPath = await handleSchoolRequest("POST", "/school/nope", new Headers(), "{}", deps);
    expect(badPath.status).toBe(404);
    const noEnvelope = await handleSchoolRequest("POST", "/school/pairing/status", new Headers(), "{}", deps);
    expect(noEnvelope.status).toBe(401);
  });
});

describe("school observations", () => {
  it("stores good batches and failing-validation batches (failed stays for forensics)", async () => {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const pending = await startPairing(deps, "pending device");
    const blocked = await signed(deps, "/school/observations", pending.keys, pending.collectorId,
      canonical(fixtureBatch("read-blocked")), clock.nowIso());
    expect(blocked.status).toBe(403);

    const active = await startPairing(deps);
    await deps.db.prepare(`UPDATE school_collector_keys SET status = 'active' WHERE collector_id = ?`)
      .bind(active.collectorId).run();

    const good = await signed(deps, "/school/observations", active.keys, active.collectorId,
      canonical(fixtureBatch("read-1")), clock.nowIso());
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ outcome: "good" });

    const evil = fixtureBatch("read-evil");
    (evil.routes as Record<string, unknown>[]).push(route("/d2l/api/le/1.82/29940528/evil/", []));
    const bad = await signed(deps, "/school/observations", active.keys, active.collectorId,
      canonical(evil), clock.nowIso());
    expect(bad.status).toBe(400);

    const rows = await deps.db.prepare(`SELECT batch_id, outcome FROM school_evidence ORDER BY received_at`).all<{ batch_id: string; outcome: string }>();
    expect(rows.results.map((r) => r.outcome)).toEqual(["good", "failed"]);
  });
});

describe("evidence extractors (real D2L fixtures)", () => {
  const NOW = new Date("2026-09-26T19:00:00.000Z");

  it("extracts assignments with submissions, grades, weights and feedback linked", () => {
    const ext = extractEvidence(parseSchoolBatch(fixtureBatch("read-x"), NOW));
    const worksheet = ext.items.find((i) => i.kind === "assignment" && i.title.includes("Entry Modes"));
    expect(worksheet).toMatchObject({
      status: "graded",
      grade: 17,
      gradeMax: 20,
      weight: 5,
      dueAt: "2026-09-19T03:59:00.000Z",
      feedback: "Good use of the slides. Expand question 4 with a second example.",
    });
    expect(worksheet?.url).toContain("folder_submit_files.d2l?db=550012&ou=29940528");
    expect(worksheet?.submittedAt).toBe("2026-09-18T23:41:00.000Z");

    const report = ext.items.find((i) => i.title.includes("Culture Report"));
    expect(report?.status).toBeNull(); // no submissions route for it: unknown, not "missing"
    expect(report?.weight).toBe(15); // grade object still carries the weight over

    const quiz = ext.items.find((i) => i.kind === "quiz");
    expect(quiz).toMatchObject({ title: "Unit 1 Check-in Quiz", grade: 8, gradeMax: 10, weight: 3 });
    expect(quiz?.url).toContain("quiz_summary.d2l?qi=44021&ou=29940528");
    expect(ext.items.some((i) => i.title.includes("Archived practice"))).toBe(false);

    // Cross-surface linkage: the Content topic "Submit: Unit 1 Worksheet" points
    // at this same folder, so its view rides along for adjudication.
    expect(worksheet?.contentRefs).toHaveLength(1);
    expect(worksheet?.contentRefs[0]).toMatchObject({ title: "Submit: Unit 1 Worksheet" });
    expect(worksheet?.contentRefs[0]?.url).toContain("db=550012");
    const lesson = ext.items.find((i) => i.kind === "lesson" && i.title.includes("Lesson 1.1"));
    expect(lesson?.dueAt).toBe("2026-09-12T03:59:00.000Z");

    const calc = ext.grades.find((g) => g.name === "Final Calculated Grade");
    expect(calc).toMatchObject({ grade: 82, gradeMax: 100 });
    expect(ext.readFailures).toEqual([]);
  });

  it("extracts announcements with built deep links, and content units/lessons", () => {
    const ext = extractEvidence(parseSchoolBatch(fixtureBatch("read-x"), NOW));
    const newsItems = ext.items.filter((i) => i.kind === "announcement");
    expect(newsItems).toHaveLength(1); // the draft (IsPublished false) is filtered, like the app
    expect(newsItems[0]?.url).toBe("https://ldsb.elearningontario.ca/d2l/le/news/29940528/77001/view");

    const units = ext.items.filter((i) => i.kind === "unit");
    const lessons = ext.items.filter((i) => i.kind === "lesson");
    expect(units.length).toBeGreaterThan(0);
    expect(units[0]?.title).toContain("Unit 1");
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0]?.url?.startsWith("https://ldsb.elearningontario.ca/content/")).toBe(true);
  });

  it("reads the enrollment manifest from host-failure batches", () => {
    const ext = extractEvidence(parseSchoolBatch(hostFailureBatch(), NOW));
    expect(ext.courses).toContainEqual({ id: "29940528", name: "BBB4M0-01 International Business" });
    expect(ext.items).toEqual([]);
    expect(ext.readFailures).toEqual([]);
  });

  it("marks ambiguous submissions instead of guessing, and reports read failures", () => {
    const both = fixtureBatch("read-amb", { submissions: submissions.slice(0, 2) });
    const ext = extractEvidence(parseSchoolBatch(both, NOW));
    const worksheet = ext.items.find((i) => i.title.includes("Entry Modes"));
    expect(worksheet?.ambiguousSubmissions).toBe(true);
    expect(worksheet?.status).toBeNull();
    expect(worksheet?.submittedAt).toBeNull();

    const failed = fixtureBatch("read-fail");
    const routes = failed.routes as Record<string, unknown>[];
    const newsRoute = routes.find((r) => String(r.route).endsWith("/news/"));
    if (!newsRoute) throw new Error("news route missing");
    newsRoute.complete = false;
    newsRoute.status = 0;
    newsRoute.body = { collectorFailure: "session_expired" };
    const ext2 = extractEvidence(parseSchoolBatch(failed, NOW));
    expect(ext2.readFailures).toContainEqual({
      route: `${P}/news/`, fetchedAt: FETCHED, status: 0, code: "session_expired",
    });
    expect(ext2.items.some((i) => i.kind === "announcement")).toBe(false);
  });

  it("surfaces refused (403) reads as gaps, never silent drops", () => {
    const refused = fixtureBatch("read-403");
    const routes = refused.routes as Record<string, unknown>[];
    const newsRoute = routes.find((r) => String(r.route).endsWith("/news/"));
    if (!newsRoute) throw new Error("news route missing");
    newsRoute.status = 403;
    newsRoute.body = { Message: "forbidden" };
    const ext = extractEvidence(parseSchoolBatch(refused, NOW));
    expect(ext.readFailures).toContainEqual({
      route: `${P}/news/`, fetchedAt: FETCHED, status: 403, code: "refused",
    });
  });

  it("diffs consecutive batches: due changes and new announcements", () => {
    const clock = new Date("2026-09-26T19:00:00.000Z");
    const oldE = extractEvidence(parseSchoolBatch(fixtureBatch("read-1", { newsItems: news.slice(0, 1) }), clock));
    const fresh = fixtureBatch("read-2", {
      due: "2026-09-26T03:59:00.000Z",
      newsItems: [...news, {
        Id: 77003, Title: "Field trip forms", Body: { Text: "Bring forms." },
        StartDate: "2026-09-26T12:00:00.000Z", EndDate: null, IsPublished: true,
      }],
    });
    const newE = extractEvidence(parseSchoolBatch(fresh, clock));
    const changes = diffExtracted(oldE, newE);
    expect(changes).toContainEqual(expect.objectContaining({
      kind: "due_date", field: "dueAt",
      oldValue: "2026-09-19T03:59:00.000Z", newValue: "2026-09-26T03:59:00.000Z",
    }));
    expect(changes).toContainEqual(expect.objectContaining({ kind: "announcement" }));
    expect(changes.some((c) => c.kind === "announcement" && c.summary.includes("Field trip"))).toBe(true);
  });
});

describe("school tools", () => {
  async function twoBatches(): Promise<{ h: ReturnType<typeof makeHarness>; t1: string }> {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const h = makeHarness([], { clock, db: deps.db });
    const device = await startPairing(deps);
    await deps.db.prepare(`UPDATE school_collector_keys SET status = 'active' WHERE collector_id = ?`)
      .bind(device.collectorId).run();
    const post = async (batch: Record<string, unknown>): Promise<void> => {
      const res = await signed(deps, "/school/observations", device.keys, device.collectorId,
        canonical(batch), clock.nowIso());
      if (res.status !== 200) throw new Error(`post failed: ${JSON.stringify(res.body)}`);
    };
    await post(fixtureBatch("read-1", { newsItems: news.slice(0, 1) }));
    const t1 = clock.nowIso();
    clock.advance(5 * 60 * 1000);
    await post(fixtureBatch("read-2", {
      due: "2026-09-26T03:59:00.000Z",
      newsItems: [...news, {
        Id: 77003, Title: "Field trip forms", Body: { Text: "Bring forms." },
        StartDate: "2026-09-26T12:00:00.000Z", EndDate: null, IsPublished: true,
      }],
    }));
    return { h, t1 };
  }

  it("snapshot reads the latest evidence with freshness and honest gaps", async () => {
    const { h } = await twoBatches();
    const ctx = h.ctxFor(ownerEvent("what is due?"));
    const snap = await schoolSnapshotRead.run({}, ctx);
    expect(snap.ok).toBe(true);
    const data = snap.data as Record<string, unknown[]>;
    const items = data.items as Record<string, unknown>[];
    // Graded worksheet is completed → excluded by default.
    expect(items.some((i) => String(i.title).includes("Entry Modes"))).toBe(false);
    expect(data.evidenceAsOf).toHaveLength(1);
    expect(data.evidenceGaps).toEqual(["discussions are not pushed by the extension yet"]);

    const withCompleted = await schoolSnapshotRead.run({ include_completed: true }, ctx);
    const items2 = (withCompleted.data as Record<string, unknown[]>).items as Record<string, unknown>[];
    expect(items2.some((i) => String(i.title).includes("Entry Modes"))).toBe(true);

    const onlyNews = await schoolSnapshotRead.run({ kinds: ["announcement"] }, ctx);
    const newsOnly = (onlyNews.data as Record<string, unknown[]>).items as Record<string, unknown>[];
    expect(newsOnly.length).toBeGreaterThan(0);
    expect(newsOnly.every((i) => i.kind === "announcement")).toBe(true);

    const undated = await schoolSnapshotRead.run(
      { kinds: ["assignment"], include_completed: true, include_undated: false }, ctx);
    const dated = (undated.data as Record<string, unknown[]>).items as Record<string, unknown>[];
    expect(dated.every((i) => i.dueAt !== null)).toBe(true);
  });

  it("changes_since reports what moved between batches", async () => {
    const { h, t1 } = await twoBatches();
    const ctx = h.ctxFor(ownerEvent("what changed?"));
    const res = await schoolChangesSince.run({ since: t1 }, ctx);
    expect(res.ok).toBe(true);
    const changes = (res.data as Record<string, unknown[]>).changes as Record<string, unknown>[];
    expect(changes).toContainEqual(expect.objectContaining({ kind: "due_date" }));
    expect(changes).toContainEqual(expect.objectContaining({ kind: "announcement" }));
    const filtered = await schoolChangesSince.run({ since: t1, kinds: ["due_date"] }, ctx);
    const only = (filtered.data as Record<string, unknown[]>).changes as Record<string, unknown>[];
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((c) => c.kind === "due_date")).toBe(true);
    const bad = await schoolChangesSince.run({ since: "not-a-date" }, ctx);
    expect(bad.ok).toBe(false);
  });

  it("changes_since sees a change even when many batches came after it (no 10-batch window)", async () => {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const h = makeHarness([], { clock, db: deps.db });
    const device = await startPairing(deps);
    await deps.db.prepare(`UPDATE school_collector_keys SET status = 'active' WHERE collector_id = ?`)
      .bind(device.collectorId).run();
    const post = async (batch: Record<string, unknown>): Promise<void> => {
      clock.advance(60 * 1000);
      const res = await signed(deps, "/school/observations", device.keys, device.collectorId, canonical(batch), clock.nowIso());
      if (res.status !== 200) throw new Error(`post failed: ${JSON.stringify(res.body)}`);
    };
    await post(fixtureBatch("base"));
    const since = clock.nowIso();
    // Two successive moves, then a busy stretch of identical batches: both moves must be reported,
    // not just "base → final" (which is all a newest-10 window can see).
    await post(fixtureBatch("moved-1", { due: "2026-09-26T03:59:00.000Z" }));
    await post(fixtureBatch("moved-2", { due: "2026-10-03T03:59:00.000Z" }));
    for (let i = 0; i < 12; i++) await post(fixtureBatch(`same-${i}`, { due: "2026-10-03T03:59:00.000Z" }));
    const res = await schoolChangesSince.run({ since }, h.ctxFor(ownerEvent("what changed?")));
    const changes = (res.data as Record<string, unknown[]>).changes as Record<string, unknown>[];
    const dueMoves = changes.filter((c) => c.kind === "due_date");
    expect(dueMoves.map((c) => c.newValue)).toEqual(expect.arrayContaining(["2026-09-26T03:59:00.000Z", "2026-10-03T03:59:00.000Z"]));
    // A baseline existed, so nothing is misreported as "first evidence".
    expect(changes.some((c) => String(c.summary).startsWith("First evidence"))).toBe(false);
  });

  it("snapshot: no limit = everything; a limit is honoured and reported; a bad limit is refused", async () => {
    const { h } = await twoBatches();
    const ctx = h.ctxFor(ownerEvent("everything"));
    const all = (await schoolSnapshotRead.run({ include_completed: true }, ctx)).data as Record<string, unknown>;
    expect((all.items as unknown[]).length).toBe(all.total);
    expect(all.truncated).toBe(false);
    const one = (await schoolSnapshotRead.run({ include_completed: true, limit: 1 }, ctx)).data as Record<string, unknown>;
    expect(one.items as unknown[]).toHaveLength(1);
    expect(one.truncated).toBe(true);
    expect((await schoolSnapshotRead.run({ limit: 0 }, ctx)).status).toBe("refused");
  });

  it("the vault export includes school items and grades with their freshness", async () => {
    const { h } = await twoBatches();
    const snap = await schoolVaultSnapshot(h.school!.evidence, new Date(h.clock.nowMs()));
    const exported = buildVaultExport([], [], { school: snap });
    const paths = exported.notes.map((n) => n.path);
    expect(paths).toContain("jarvis/school/courses.md");
    expect(paths.some((p) => p.startsWith("jarvis/school/items/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("jarvis/school/grades/"))).toBe(true);
    expect(paths.every((p) => /^[A-Za-z0-9._\/-]+$/.test(p))).toBe(true); // filename-safe
    const item = exported.notes.find((n) => n.path.startsWith("jarvis/school/items/"))!;
    expect(item.markdown).toContain("evidence_as_of:");
    expect(item.markdown).toMatch(/due_at: (\d{4}-|unknown)/);
    expect(exported.count).toBe(exported.notes.length);
  });

  it("queues sync/open requests, validates URLs, and reports status", async () => {
    const { h } = await twoBatches();
    const ctx = h.ctxFor(ownerEvent("sync now"));
    const sync = await schoolSyncRequest.run({ reason: "Sid asked" }, ctx);
    expect(sync).toMatchObject({ ok: true, status: "queued" });
    const open = await schoolItemOpen.run({
      item_url: "https://ldsb.elearningontario.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?db=550012&ou=29940528",
    }, ctx);
    expect(open).toMatchObject({ ok: true, status: "queued" });
    const evil = await schoolItemOpen.run({ item_url: "https://evil.example/x" }, ctx);
    expect(evil.ok).toBe(false);
    const plain = await schoolItemOpen.run({ item_url: "http://ldsb.elearningontario.ca/x" }, ctx);
    expect(plain.ok).toBe(false);

    const status = await schoolD2lStatus.run({}, ctx);
    expect(status.ok).toBe(true);
    const data = status.data as { devices: unknown[]; courses: unknown[]; queuedRequests: number };
    expect(data.devices).toHaveLength(1);
    expect(data.courses).toHaveLength(1);
    expect(data.queuedRequests).toBe(2);
  });

  it("fails closed without a database", async () => {
    const h = makeHarness([]);
    const ctx = h.ctxFor(ownerEvent("what is due?"));
    expect(h.dispatcher.list().some((t) => t.name === "school_snapshot_read")).toBe(false);
    const snap = await schoolSnapshotRead.run({}, ctx);
    expect(snap).toMatchObject({ ok: false, status: "not_connected" });
  });
});

describe("school pull channel", () => {
  it("hands over queued requests oldest-first and marks them delivered", async () => {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const device = await startPairing(deps);
    await deps.db.prepare(`UPDATE school_collector_keys SET status = 'active' WHERE collector_id = ?`)
      .bind(device.collectorId).run();
    const requests = new SchoolRequests(deps.db);
    await requests.enqueue("sreq_1", "sync_now", { reason: "stale" }, clock.nowIso());
    clock.advance(1000);
    await requests.enqueue("sreq_2", "open_item", { itemUrl: "https://ldsb.elearningontario.ca/x" }, clock.nowIso());

    const first = await signed(deps, "/school/pull", device.keys, device.collectorId,
      canonical({}), clock.nowIso());
    expect(first.status).toBe(200);
    const body = first.body as { requests: { requestId: string; action: string; args: unknown }[] };
    expect(body.requests.map((r) => r.requestId)).toEqual(["sreq_1", "sreq_2"]);
    expect(body.requests[0]).toMatchObject({ action: "sync_now", args: { reason: "stale" } });

    const second = await signed(deps, "/school/pull", device.keys, device.collectorId,
      canonical({}), clock.nowIso());
    expect((second.body as { requests: unknown[] }).requests).toEqual([]);
    expect(await requests.queuedCount()).toBe(0);
  });

  it("refuses pull for pending keys and rejects bad bodies", async () => {
    const clock = new FixedClock("2026-09-26T19:00:00.000Z");
    const deps = depsFor(clock);
    const pending = await startPairing(deps);
    const blocked = await signed(deps, "/school/pull", pending.keys, pending.collectorId,
      canonical({}), clock.nowIso());
    expect(blocked.status).toBe(403);

    const stranger = await genKeypair();
    const unknown = await signed(deps, "/school/pull", stranger, "col_stranger",
      canonical({}), clock.nowIso());
    expect(unknown.status).toBe(403);
  });
});
