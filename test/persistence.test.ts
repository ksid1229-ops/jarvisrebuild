/**
 * Persistence: the D1 adapters against REAL SQLite, running the REAL migration
 * files (migrations/0001_init.sql + 0002). This is what proves the adapters and
 * the schema agree — not a mirror, the actual SQL. Production swaps the sql.js
 * shim below for the D1 binding, which speaks the same prepare/bind/first/all/run.
 */
import { describe, expect, it, beforeAll } from "vitest";
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import migration0001 from "../migrations/0001_init.sql?raw";
import migration0002 from "../migrations/0002_school_surface.sql?raw";
import { FixedClock } from "../src/clock.js";
import type { D1Bound, D1Db, D1Prepared, D1Row, D1RunResult } from "../src/persistence/d1.js";
import { D1FactsRepo } from "../src/memory/facts-repo.js";
import { D1ConversationRepo } from "../src/conversation/conversation-repo.js";
import { D1ReceiptsRepo } from "../src/receipts/receipts-repo.js";
import { D1PendingActionsRepo } from "../src/confirmations/pending-actions.js";
import { D1SettingsRepo } from "../src/settings/settings-repo.js";
import { D1ConnectedAppsRepo } from "../src/apps/app-registry.js";
import { D1AppEventsRepo } from "../src/apps/app-events.js";
import { D1GuestsRepo } from "../src/voice/guests-repo.js";
import { D1WakeupsRepo } from "../src/scheduler/wakeups-repo.js";
import { D1HeartbeatRepo } from "../src/plumbing/heartbeat.js";

let SQL: initSqlJs.SqlJsStatic | null = null;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => `node_modules/sql.js/dist/${f}` });
});

/** sql.js-backed D1Db: real SQLite semantics for prepare/bind/first/all/run. */
class SqlJsDb implements D1Db {
  constructor(private readonly db: Database) {}
  prepare(query: string): D1Prepared {
    const db = this.db;
    const select = (params: unknown[]): D1Row[] => {
      const stmt = db.prepare(query);
      try {
        if (params.length > 0) stmt.bind(params as SqlValue[]);
        const rows: D1Row[] = [];
        while (stmt.step()) rows.push({ ...(stmt.getAsObject() as D1Row) });
        return rows;
      } finally {
        stmt.free();
      }
    };
    const bound = (params: unknown[]): D1Bound => ({
      first: async <T,>(column?: string): Promise<T | null> => {
        const rows = select(params);
        const row = rows[0];
        if (!row) return null;
        if (column !== undefined) return (row[column] ?? null) as T;
        return row as unknown as T;
      },
      all: async <T,>(): Promise<{ results: T[] }> => ({ results: select(params) as unknown as T[] }),
      run: async (): Promise<D1RunResult> => {
        db.run(query, params as SqlValue[]);
        return { success: true, changes: db.getRowsModified() };
      },
    });
    return {
      bind: (...params: unknown[]) => bound(params),
      first: <T,>(column?: string) => bound([]).first<T>(column),
      all: <T,>() => bound([]).all<T>(),
      run: () => bound([]).run(),
    };
  }
}

function freshDb(): SqlJsDb {
  if (!SQL) throw new Error("sql.js not initialized");
  const db = new SQL.Database();
  // THE migration files, not a copy. If they drift from the adapters, this fails.
  db.exec(migration0001);
  db.exec(migration0002);
  return new SqlJsDb(db);
}

describe("D1 persistence (real SQLite + real migrations)", () => {
  it("facts: save/get/correct-chain/explain/forget/pin/expiry", async () => {
    const clock = new FixedClock("2026-09-26T12:00:00.000Z");
    const facts = new D1FactsRepo(freshDb(), clock);
    const f1 = await facts.save({
      text: "Sid has an iPhone 15", kind: "durable", confidence: "stated",
      sourceType: "conversation", sourceRef: "x", expiresAt: null,
    });
    expect((await facts.get(f1.id))?.text).toContain("iPhone 15");
    const f2 = await facts.correct(f1.id, "Sid has an iPhone 16", "confirmed", "durable", null);
    expect((await facts.get(f1.id))?.supersededBy).toBe(f2.id);
    expect((await facts.explain(f2.id)).map((f) => f.text)).toEqual([
      "Sid has an iPhone 15",
      "Sid has an iPhone 16",
    ]);
    // Superseded facts are not active; pinning the new version profiles it.
    expect((await facts.activeFacts()).map((f) => f.text)).toEqual(["Sid has an iPhone 16"]);
    await facts.pin(f2.id);
    expect((await facts.pinnedFacts()).map((f) => f.id)).toEqual([f2.id]);
    await facts.forget(f2.id);
    expect(await facts.activeFacts()).toHaveLength(0);
    await facts.restore(f2.id);
    expect(await facts.activeFacts()).toHaveLength(1);
    // Temporary facts drop out after expiry.
    const temp = await facts.save({
      text: "away this weekend", kind: "temporary", confidence: "stated",
      sourceType: "conversation", sourceRef: "x", expiresAt: "2026-09-27T12:00:00.000Z",
    });
    expect((await facts.activeFacts()).map((f) => f.id)).toContain(temp.id);
    clock.set("2026-09-28T12:00:00.000Z");
    expect((await facts.activeFacts()).map((f) => f.id)).not.toContain(temp.id);
  });

  it("conversation: append/all/recent/search/summary threshold/rollup order", async () => {
    const clock = new FixedClock("2026-09-26T12:00:00.000Z");
    const convo = new D1ConversationRepo(freshDb(), clock, 2);
    await convo.append("user", "hello", "text");
    await convo.append("assistant", "hi there", "text");
    await convo.append("user", "call me later", "voice");
    expect((await convo.all()).map((m) => m.content)).toEqual(["hello", "hi there", "call me later"]);
    expect((await convo.recent(2)).map((m) => m.content)).toEqual(["hi there", "call me later"]);
    expect((await convo.literalSearch("CALL")).map((m) => m.content)).toEqual(["call me later"]);
    expect(await convo.needsSummary()).toBe(true); // 3 unsummarized > threshold 2
    const rolled = await convo.applySummary("old chat", 2);
    expect(rolled.map((m) => m.content)).toEqual(["hello", "hi there"]);
    const after = await convo.all();
    expect(after.map((m) => m.content)).toEqual(["old chat", "call me later"]);
    expect(after[0]?.isSummary).toBe(true);
    expect(await convo.needsSummary()).toBe(false);
  });

  it("receipts: log + window/tool filters", async () => {
    const clock = new FixedClock("2026-09-26T12:00:00.000Z");
    const receipts = new D1ReceiptsRepo(freshDb(), clock);
    await receipts.log({ tool: "send_text", input: {}, result: {}, trigger: "text", performed: true, status: "ok" });
    clock.set("2026-09-26T13:00:00.000Z");
    await receipts.log({ tool: "send_email", input: {}, result: {}, trigger: "text", performed: false, status: "not_connected" });
    expect(await receipts.all()).toHaveLength(2);
    expect((await receipts.query({ tool: "send_email" })).map((r) => r.status)).toEqual(["not_connected"]);
    expect(await receipts.query({ fromIso: "2026-09-26T12:30:00.000Z" })).toHaveLength(1);
    expect(await receipts.query({ toIso: "2026-09-26T12:30:00.000Z" })).toHaveLength(1);
  });

  it("pending actions: create/match/confirm/cancel/expiry guards", async () => {
    const clock = new FixedClock("2026-09-26T12:00:00.000Z");
    const pending = new D1PendingActionsRepo(freshDb(), clock);
    const args = { to: "a@b.c", subject: "hi", body: "x" };
    const a = await pending.create({ tool: "send_email", args, summary: "s", ownerId: "sid", creatingEventId: "e1" });
    expect(await pending.findPendingMatch("send_email", args, "sid")).toBeTruthy();
    expect(await pending.findPendingMatch("send_email", { ...args, body: "y" }, "sid")).toBeUndefined();
    // Same-turn self-confirm refuses.
    await expect(pending.confirm(a.id, "sid", "e1")).rejects.toThrow("same turn");
    const confirmed = await pending.confirm(a.id, "sid", "e2");
    expect(confirmed.status).toBe("confirmed");
    // Single-use: second confirm refuses.
    await expect(pending.confirm(a.id, "sid", "e3")).rejects.toThrow("not pending");
    // Expiry flips status and refuses.
    const b = await pending.create({ tool: "spend_money", args: {}, summary: "s", ownerId: "sid", creatingEventId: "e1" });
    clock.set("2026-09-26T12:11:00.000Z");
    await expect(pending.confirm(b.id, "sid", "e9")).rejects.toThrow("expired");
    expect((await pending.get(b.id))?.status).toBe("expired");
    const c = await pending.create({ tool: "make_call", args: {}, summary: "s", ownerId: "sid", creatingEventId: "e1" });
    expect((await pending.cancel(c.id, "sid")).status).toBe("cancelled");
    await pending.markExecuted(a.id);
    expect((await pending.get(a.id))?.status).toBe("executed");
  });

  it("settings: shadow flags round-trip", async () => {
    const settings = new D1SettingsRepo(freshDb());
    expect(await settings.isShadow()).toBe(false);
    await settings.set("shadow", "on");
    expect(await settings.isShadow()).toBe(true);
    expect(await settings.isFeatureShadow("anything")).toBe(true);
    await settings.set("shadow", "off");
    await settings.set("shadow:email", "on");
    expect(await settings.isShadow()).toBe(false);
    expect(await settings.isFeatureShadow("email")).toBe(true);
    expect(await settings.isFeatureShadow("calls")).toBe(false);
    expect(await settings.all()).toEqual({ shadow: "off", "shadow:email": "on" });
  });

  it("wakeups/guests/apps/events/heartbeat round-trip", async () => {
    const clock = new FixedClock("2026-09-26T12:00:00.000Z");
    const db = freshDb();
    const wakeups = new D1WakeupsRepo(db, clock);
    await wakeups.add("2026-09-28T10:00:00.000Z", "later");
    const sooner = await wakeups.add("2026-09-27T09:00:00.000Z", "sooner");
    expect((await wakeups.list()).map((w) => w.reason)).toEqual(["sooner", "later"]);
    expect(await wakeups.remove(sooner.id)).toBe(true);
    expect(await wakeups.remove(sooner.id)).toBe(false);

    const guests = new D1GuestsRepo(db, clock);
    const g = await guests.create({
      name: "Mom", phone: "+1guest", pinHash: "h", access: "x",
      expiresAt: "2026-09-27T12:00:00.000Z",
    });
    expect((await guests.activeByPhone("+1guest"))?.id).toBe(g.id);
    clock.set("2026-09-28T12:00:00.000Z");
    expect(await guests.activeByPhone("+1guest")).toBeUndefined();
    expect(await guests.revoke(g.id)).toBe(true);

    const apps = new D1ConnectedAppsRepo(db, clock);
    const app = await apps.add({ name: "school", baseUrl: "https://x", authSecret: "s" });
    expect((await apps.byName("school"))?.id).toBe(app.id);
    expect(await apps.list()).toHaveLength(1);
    expect(await apps.remove(app.id)).toBe(true);

    const events = new D1AppEventsRepo(db, clock);
    await events.store("school", { hello: 1 });
    expect(await events.all()).toHaveLength(1);

    const beats = new D1HeartbeatRepo(db, clock);
    await beats.record("cron");
    expect(await beats.last("cron")).toBe("2026-09-28T12:00:00.000Z");
    expect(await beats.last("nope")).toBeUndefined();
  });

  it("school tables: keys lookup + nonce single-use SQL behave", async () => {
    const db = freshDb();
    await db
      .prepare(
        `INSERT INTO school_collector_keys
         (collector_id, principal_id, public_key_base64, device_label, status, challenge, pairing_code, expires_at, decision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("c1", "sid", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "Opera", "active", "ch", "481-902", "2026-09-27T12:00:00.000Z", null)
      .run();
    const key = await db
      .prepare(`SELECT * FROM school_collector_keys WHERE collector_id = ? AND status = ?`)
      .bind("c1", "active")
      .first<D1Row>();
    expect(key?.pairing_code).toBe("481-902");
    // The exact nonce SQL from verifyCollectorRequest: first insert wins, replay loses.
    const nonceSql =
      `INSERT INTO school_collector_nonces (collector_id, nonce, used_at)
       SELECT collector_id, ?, ? FROM school_collector_keys WHERE collector_id = ? AND status = ?
       ON CONFLICT DO NOTHING RETURNING collector_id`;
    const first = await db.prepare(nonceSql).bind("n1", "2026-09-26T12:00:00.000Z", "c1", "active").first<D1Row>();
    expect(first?.collector_id).toBe("c1");
    const replay = await db.prepare(nonceSql).bind("n1", "2026-09-26T12:00:00.000Z", "c1", "active").first<D1Row>();
    expect(replay).toBeNull();
  });

  it("the schema itself refuses bad enums (defense in depth, not just code)", async () => {
    const db = freshDb();
    await expect(
      db
        .prepare(
          `INSERT INTO facts (id, text, kind, confidence, source_type, source_ref, created_at, expires_at, superseded_by, hidden, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("f1", "x", "bogus-kind", "stated", "conversation", "x", "2026-09-26T12:00:00.000Z", null, null, 0, 0)
        .run(),
    ).rejects.toThrow();
  });
});
