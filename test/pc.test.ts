import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { JarvisDurableObject } from "../src/index.js";
import { freshDb } from "./d1-testkit.js";
import { D1PcJobsRepo } from "../src/pc/pc-jobs-repo.js";
import { D1PcHeartbeatRepo, InMemoryPcHeartbeatRepo, PC_ONLINE_WINDOW_MS } from "../src/pc/pc-tools.js";
import { InMemoryPcJobsRepo } from "../src/pc/pc-jobs-repo.js";
import { FixedClock } from "../src/clock.js";
import { makeHarness, ownerEvent } from "./helpers.js";
import type { Env } from "../src/env.js";

const ctxStub = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) };

function pcEnv(extra: Partial<Env> = {}): { env: Env; db: ReturnType<typeof freshDb> } {
  const db = freshDb();
  const env = { DB: db, PC_AGENT_TOKEN: "sectok", ...extra } as unknown as Env;
  return { env, db };
}

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Routes: token-gated, fail closed
// ---------------------------------------------------------------------------

describe("pc: routes are token-gated and fail closed", () => {
  it("no PC_AGENT_TOKEN configured => every request refused (403), not open", async () => {
    const { env, db } = pcEnv();
    delete (env as { PC_AGENT_TOKEN?: string }).PC_AGENT_TOKEN;
    for (const path of ["/pc/pull", "/pc/heartbeat", "/pc/result"]) {
      const res = await worker.fetch(req(`https://j.example${path}`, { method: "POST", headers: { authorization: "Bearer anything" }, body: "{}" }), env, ctxStub);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ reason: expect.stringContaining("PC_AGENT_TOKEN is not configured") });
    }
    void db;
  });

  it("a wrong or missing bearer token => 401", async () => {
    const { env } = pcEnv();
    const bad = await worker.fetch(req("https://j.example/pc/pull", { headers: { authorization: "Bearer wrong" } }), env, ctxStub);
    expect(bad.status).toBe(401);
    const none = await worker.fetch(req("https://j.example/pc/pull"), env, ctxStub);
    expect(none.status).toBe(401);
  });

  it("no DB binding => honest 500, nothing faked", async () => {
    const env = { PC_AGENT_TOKEN: "sectok" } as unknown as Env;
    const res = await worker.fetch(req("https://j.example/pc/pull", { headers: { authorization: "Bearer sectok" } }), env, ctxStub);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ reason: expect.stringContaining("DB binding") });
  });
});

// ---------------------------------------------------------------------------
// Heartbeat + pull + result against real D1
// ---------------------------------------------------------------------------

describe("pc: heartbeat, pull and result (real D1)", () => {
  it("heartbeat records last-seen and the agent version", async () => {
    const { env, db } = pcEnv();
    const res = await worker.fetch(
      req("https://j.example/pc/heartbeat", { method: "POST", headers: { authorization: "Bearer sectok", "content-type": "application/json" }, body: JSON.stringify({ version: "1.2.3" }) }),
      env,
      ctxStub,
    );
    expect(res.status).toBe(200);
    const hb = await new D1PcHeartbeatRepo(db, new FixedClock()).get();
    expect(hb!.version).toBe("1.2.3");
    expect(Date.parse(hb!.lastSeen)).not.toBeNaN();
  });

  it("pull returns the oldest queued jobs first and marks them delivered (no double delivery)", async () => {
    const { env, db } = pcEnv();
    const jobs = new D1PcJobsRepo(db, new FixedClock());
    const j1 = await jobs.enqueue("shell", { command: "echo first" });
    const j2 = await jobs.enqueue("open_url", { url: "https://x.example" });
    const res = await worker.fetch(req("https://j.example/pc/pull", { headers: { authorization: "Bearer sectok" } }), env, ctxStub);
    const body = (await res.json()) as { jobs: { id: string; kind: string; args: Record<string, unknown> }[] };
    expect(body.jobs.map((j) => j.id)).toEqual([j1.id, j2.id]);
    expect(body.jobs[0]!.args).toEqual({ command: "echo first" });
    // A second pull gets nothing: those jobs are already delivered.
    const res2 = await worker.fetch(req("https://j.example/pc/pull", { headers: { authorization: "Bearer sectok" } }), env, ctxStub);
    expect(((await res2.json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("result marks done or failed; an unknown job is a 404, never silently acked", async () => {
    const { env, db } = pcEnv();
    const jobs = new D1PcJobsRepo(db, new FixedClock());
    const j1 = await jobs.enqueue("shell", { command: "echo hi" });
    await jobs.next(5);
    const ok = await worker.fetch(
      req("https://j.example/pc/result", { method: "POST", headers: { authorization: "Bearer sectok", "content-type": "application/json" }, body: JSON.stringify({ jobId: j1.id, ok: true, result: { exitCode: 0, stdout: "hi" } }) }),
      env,
      ctxStub,
    );
    expect(ok.status).toBe(200);
    expect((await jobs.get(j1.id))!.status).toBe("done");
    expect(JSON.parse((await jobs.get(j1.id))!.resultJson!)).toEqual({ exitCode: 0, stdout: "hi" });

    const j2 = await jobs.enqueue("shell", { command: "boom" });
    await jobs.next(5);
    const fail = await worker.fetch(
      req("https://j.example/pc/result", { method: "POST", headers: { authorization: "Bearer sectok", "content-type": "application/json" }, body: JSON.stringify({ jobId: j2.id, ok: false, error: "exit 1" }) }),
      env,
      ctxStub,
    );
    expect(fail.status).toBe(200);
    expect((await jobs.get(j2.id))!.status).toBe("failed");

    const ghost = await worker.fetch(
      req("https://j.example/pc/result", { method: "POST", headers: { authorization: "Bearer sectok", "content-type": "application/json" }, body: JSON.stringify({ jobId: "pcjob_ghost", ok: true }) }),
      env,
      ctxStub,
    );
    expect(ghost.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tools: pc_status / pc_execute
// ---------------------------------------------------------------------------

describe("pc: pc_status and pc_execute tools", () => {
  function pcHarness(clock = new FixedClock()) {
    return makeHarness([{ content: "x" }], {
      clock,
      stores: { pcJobs: new InMemoryPcJobsRepo(), pcHeartbeat: new InMemoryPcHeartbeatRepo(clock) },
    });
  }

  it("pc_status: never seen / offline after the window / online within it, with pending count", async () => {
    const clock = new FixedClock("2026-09-27T12:00:00.000Z");
    const h = pcHarness(clock);
    const never = await h.dispatcher.dispatch("pc_status", {}, h.ctxFor(ownerEvent("is my pc on?", "e1")));
    expect(never.ok).toBe(true);
    expect((never.data as { online: boolean; ever_seen: boolean }).ever_seen).toBe(false);

    await h.pcHeartbeat!.record("1.0.0");
    clock.advance(PC_ONLINE_WINDOW_MS - 1000);
    const online = await h.dispatcher.dispatch("pc_status", {}, h.ctxFor(ownerEvent("e", "e1")));
    expect((online.data as { online: boolean }).online).toBe(true);

    clock.advance(PC_ONLINE_WINDOW_MS);
    const offline = await h.dispatcher.dispatch("pc_status", {}, h.ctxFor(ownerEvent("e", "e1")));
    expect((offline.data as { online: boolean }).online).toBe(false);
    expect(offline.message).toContain("offline");
  });

  it("pc_execute queues a shell job and reports it queued (with PC online state)", async () => {
    const h = pcHarness();
    await h.pcHeartbeat!.record();
    const res = await h.dispatcher.dispatch("pc_execute", { kind: "shell", command: "Get-Date", note: "checking date" }, h.ctxFor(ownerEvent("e", "e1")));
    expect(res.ok).toBe(true);
    expect(res.status).toBe("queued_on_pc");
    expect(res.message).toContain("online");
    const job = (await h.pcJobs!.all())[0]!;
    expect(job.kind).toBe("shell");
    expect(JSON.parse(job.argsJson)).toEqual({ command: "Get-Date", note: "checking date" });
  });

  it("pc_execute validates shape: unknown kind, missing command, missing url, bad timeout", async () => {
    const h = pcHarness();
    const ctx = h.ctxFor(ownerEvent("e", "e1"));
    expect((await h.dispatcher.dispatch("pc_execute", { kind: "format_c" }, ctx)).status).toBe("refused");
    expect((await h.dispatcher.dispatch("pc_execute", { kind: "shell" }, ctx)).status).toBe("refused");
    expect((await h.dispatcher.dispatch("pc_execute", { kind: "open_url" }, ctx)).status).toBe("refused");
    expect((await h.dispatcher.dispatch("pc_execute", { kind: "browser", url: "https://x" }, ctx)).status).toBe("queued_on_pc");
    expect((await h.dispatcher.dispatch("pc_execute", { kind: "shell", command: "x", timeout_seconds: 9999 }, ctx)).status).toBe("refused");
  });

  it("without the PC surface wired (no D1) the tools are honestly not_connected", async () => {
    const h = makeHarness([{ content: "x" }]); // no pc stores, no db
    expect((await h.dispatcher.dispatch("pc_status", {}, h.ctxFor(ownerEvent("e", "e1")))).status).toBe("not_connected");
    expect((await h.dispatcher.dispatch("pc_execute", { kind: "shell", command: "x" }, h.ctxFor(ownerEvent("e", "e1")))).status).toBe("not_connected");
  });
});

// ---------------------------------------------------------------------------
// spend_money (confirmed) → the PC browser job
// ---------------------------------------------------------------------------

describe("pc: spend_money queues a browser autofill job on the PC", () => {
  async function confirmedSpend(h: ReturnType<typeof makeHarness>, args: Record<string, unknown>) {
    await h.dispatcher.dispatch("spend_money", args, h.ctxFor(ownerEvent("buy tickets", "e1")));
    const pendingId = [...(h.pending as unknown as { actions: Map<string, unknown> }).actions.keys()][0] as string;
    return h.dispatcher.executeConfirmed(pendingId, h.ctxFor(ownerEvent("yes", "e2")));
  }

  it("queues the checkout on the PC with the card HINT (last4) — never a card number", async () => {
    const clock = new FixedClock();
    const h = makeHarness([{ content: "x" }], {
      clock,
      stores: { pcJobs: new InMemoryPcJobsRepo(), pcHeartbeat: new InMemoryPcHeartbeatRepo(clock) },
    });
    const res = await confirmedSpend(h, { url: "https://tickets.example/checkout", amount: 89.5, currency: "CAD", description: "2 concert tickets" });
    expect(res.status).toBe("queued_on_pc");
    expect(res.message).toContain("nothing has been bought");
    const job = (await h.pcJobs!.all())[0]!;
    expect(job.kind).toBe("browser");
    const args = JSON.parse(job.argsJson) as Record<string, unknown>;
    expect(args.url).toBe("https://tickets.example/checkout");
    expect(args.spend).toBe(true);
    expect(args.instructions).toContain("2286");
    expect(args.instructions).toContain("Do NOT invent card details");
    // There is no card number anywhere in the job or its receipt.
    expect(job.argsJson).not.toMatch(/\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}/);
    const receipts = await h.receipts.all();
    expect(receipts.some((r) => r.tool === "spend_money" && r.status === "queued_on_pc")).toBe(true);
  });

  it("a confirmed spend without a checkout URL is refused — nothing queued", async () => {
    const clock = new FixedClock();
    const h = makeHarness([{ content: "x" }], {
      clock,
      stores: { pcJobs: new InMemoryPcJobsRepo(), pcHeartbeat: new InMemoryPcHeartbeatRepo(clock) },
    });
    const res = await confirmedSpend(h, { amount: 5, currency: "CAD", description: "no url given" });
    expect(res.status).toBe("refused");
    expect(res.message).toContain("checkout page URL");
    expect(await h.pcJobs!.all()).toHaveLength(0);
  });

  it("without the PC surface, a confirmed spend is honestly not_connected", async () => {
    const h = makeHarness([{ content: "x" }]);
    const res = await confirmedSpend(h, { url: "https://x.example/pay", amount: 5, currency: "CAD", description: "x" });
    expect(res.status).toBe("not_connected");
  });
});

// ---------------------------------------------------------------------------
// DO /pc/result wake (end to end with a scripted DeepSeek)
// ---------------------------------------------------------------------------

describe("pc: DO result wake tells the brain exactly what the PC did", () => {
  it("a finished job wakes the brain with its result; the brain can text Sid", async () => {
    const db = freshDb();
    const clock = new FixedClock();
    const jobs = new D1PcJobsRepo(db, clock);
    const j1 = await jobs.enqueue("shell", { command: "Get-Date" });
    await jobs.next(5);
    await jobs.complete(j1.id, { ok: true, result: { exitCode: 0, stdout: "September 27, 2026" } });

    const seen: { messages: { role: string; content: string }[] }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { messages: { role: string; content: string }[] };
      seen.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Done — your PC ran it." } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env = { DB: db, DEEPSEEK_API_KEY: "k", OWNER_CHAT_ID: "sid", OWNER_TIMEZONE: "America/Toronto" } as unknown as Env;
      const dobj = new JarvisDurableObject({} as never, env);
      const res = await (dobj as unknown as { handlePcResult(r: Request): Promise<Response> }).handlePcResult(
        new Request("https://do/pc/result", { method: "POST", body: JSON.stringify({ jobId: j1.id }) }),
      );
      expect(res.status).toBe(200);
      const wake = seen.at(-1)!.messages.find((m) => m.role === "user")!;
      expect(wake.content).toContain("[pc result]");
      expect(wake.content).toContain("finished successfully");
      expect(wake.content).toContain("September 27, 2026");
      expect(wake.content).toContain("receipts_query");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
