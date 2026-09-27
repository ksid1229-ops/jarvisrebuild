import type { Clock } from "../clock.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { optStr, str } from "../persistence/d1.js";
import type { PcJobsStore, PcJobKind } from "./pc-jobs-repo.js";
import { PC_JOB_KINDS } from "./pc-jobs-repo.js";
import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";

/**
 * The PC heartbeat: one row, updated every time the Windows agent checks in.
 * pc_status uses it to say online/offline honestly — a quiet PC (agent down,
 * PC off) is never reported as online.
 */
export interface PcHeartbeat {
  lastSeen: string;
  version: string | null;
}

export interface PcHeartbeatStore {
  record(version?: string): Promise<void>;
  get(): Promise<PcHeartbeat | undefined>;
}

export class InMemoryPcHeartbeatRepo implements PcHeartbeatStore {
  private row: PcHeartbeat | undefined;
  constructor(private readonly clock: Clock) {}
  async record(version?: string): Promise<void> {
    this.row = { lastSeen: this.clock.nowIso(), version: version ?? null };
  }
  async get(): Promise<PcHeartbeat | undefined> {
    return this.row;
  }
}

const PC_ROW = "pc";

export class D1PcHeartbeatRepo implements PcHeartbeatStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}
  async record(version?: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO pc_heartbeat (id, last_seen, version) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, version = excluded.version`)
      .bind(PC_ROW, this.clock.nowIso(), version ?? null)
      .run();
  }
  async get(): Promise<PcHeartbeat | undefined> {
    const row = await this.db.prepare(`SELECT * FROM pc_heartbeat WHERE id = ?`).bind(PC_ROW).first<D1Row>();
    if (!row) return undefined;
    return { lastSeen: str(row.last_seen, "pc_heartbeat.last_seen"), version: optStr(row.version, "pc_heartbeat.version") };
  }
}

/** The PC counts as online if it checked in within this window (a limit, not a judgment). */
export const PC_ONLINE_WINDOW_MS = 5 * 60_000;

/** What the tools get. Absent => the PC surface is not wired (needs the DB binding). */
export interface PcServices {
  jobs: PcJobsStore;
  heartbeat: PcHeartbeatStore;
}

const notConnected = (why: string): ToolResult => ({
  ok: false,
  status: "not_connected",
  message: `${why} Nothing was queued or run.`,
});

export async function pcOnline(pc: PcServices, clock: Clock): Promise<{ online: boolean; heartbeat?: PcHeartbeat; secondsAgo?: number }> {
  const hb = await pc.heartbeat.get();
  if (!hb) return { online: false };
  const ago = clock.nowMs() - Date.parse(hb.lastSeen);
  return { online: ago <= PC_ONLINE_WINDOW_MS, heartbeat: hb, secondsAgo: Math.round(ago / 1000) };
}

/**
 * Web pages only (audit round 4): open_url and browser jobs drive Sid's REAL
 * browser profile, so their url is a web page — never file: or another scheme.
 * Local-file access already exists through the ungated shell kind (Sid's
 * recorded call), so this gate takes away nothing but surprise.
 */
const WEB_URL = /^https?:\/\//i;

/**
 * pc_execute — queue work for Sid's Windows PC. NOT one of the five confirmed
 * actions (Sid, 2026-09-26: "jarvis can do literally anything he wants" on the
 * PC); proof comes from receipts and the [pc result] wake-up instead. What code
 * does check is shape: the kind must be legal and its required field present.
 */
export const pcExecute: Tool = {
  name: "pc_execute",
  description:
    "Queue work on Sid's Windows PC. It runs when the PC agent picks it up (the PC is on most of the day; if it's " +
    "off, the job waits and you'll get the result later — pc_status says whether it's online). kind: 'shell' runs a " +
    "PowerShell command (args: command, optional timeout_seconds); 'open_url' opens a page in his default browser " +
    "(args: url); 'browser' drives his real Chrome to a page, e.g. a logged-in site (args: url, optional " +
    "instructions). Results come back to you as a [pc result] message. Everything is receipted.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...PC_JOB_KINDS] },
      command: { type: "string", description: "shell only: the PowerShell command to run." },
      url: { type: "string", description: "open_url / browser: the page address." },
      instructions: { type: "string", description: "browser only: what to do on the page." },
      timeout_seconds: { type: "number", description: "shell only: kill the command after this long (default 120)." },
      note: { type: "string", description: "Optional: why you're queueing this, for the receipt." },
    },
    required: ["kind"],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.pc) return notConnected("The PC surface is not wired (it needs the D1 binding).");
    const kind = String(args.kind ?? "") as PcJobKind;
    if (!(PC_JOB_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, status: "refused", message: `kind must be one of ${PC_JOB_KINDS.join(", ")}: ${kind}` };
    }
    if (kind === "shell" && String(args.command ?? "").trim() === "") {
      return { ok: false, status: "refused", message: "A shell job needs a command." };
    }
    if ((kind === "open_url" || kind === "browser") && String(args.url ?? "").trim() === "") {
      return { ok: false, status: "refused", message: `A ${kind} job needs a url.` };
    }
    if ((kind === "open_url" || kind === "browser") && !WEB_URL.test(String(args.url ?? "").trim())) {
      return {
        ok: false,
        status: "refused",
        message:
          `A ${kind} job takes a full web URL starting with http:// or https:// — these jobs open pages in ` +
          `Sid's real, logged-in browser (audit round 4: file: and other schemes are not pages). Send the ` +
          `complete URL, e.g. https://d2l.limestone.on.ca — a bare domain is refused rather than guessed a scheme for.`,
      };
    }
    if (kind === "shell" && args.timeout_seconds !== undefined) {
      const t = Number(args.timeout_seconds);
      if (!Number.isFinite(t) || t <= 0 || t > 600) {
        return { ok: false, status: "refused", message: "timeout_seconds must be a number between 1 and 600." };
      }
    }

    const jobArgs: Record<string, unknown> = {};
    if (args.command !== undefined) jobArgs.command = String(args.command);
    if (args.url !== undefined) jobArgs.url = String(args.url);
    if (args.instructions !== undefined) jobArgs.instructions = String(args.instructions);
    if (args.timeout_seconds !== undefined) jobArgs.timeout_seconds = Number(args.timeout_seconds);
    if (args.note !== undefined) jobArgs.note = String(args.note);

    const job = await ctx.pc.jobs.enqueue(kind, jobArgs);
    const online = await pcOnline(ctx.pc, ctx.clock);
    return {
      ok: true,
      status: "queued_on_pc",
      message:
        `Queued ${kind} job ${job.id} on Sid's PC${jobArgs.note ? ` (${jobArgs.note})` : ""}. The PC is ` +
        (online.online ? `online (checked in ${online.secondsAgo}s ago), so it should run shortly` : "offline right now, so it will run when the PC checks in") +
        ". You'll get a [pc result] when it finishes.",
      data: { job_id: job.id, pc_online: online.online },
    };
  },
};

export const pcStatus: Tool = {
  name: "pc_status",
  description:
    "Check Sid's Windows PC: whether the PC agent checked in recently (online), when it was last seen, and how many " +
    "queued jobs are waiting for it. Use it before promising anything time-sensitive.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx): Promise<ToolResult> {
    if (!ctx.pc) return notConnected("The PC surface is not wired (it needs the D1 binding).");
    const state = await pcOnline(ctx.pc, ctx.clock);
    const pending = await ctx.pc.jobs.pendingCount();
    if (!state.heartbeat) {
      return {
        ok: true,
        status: "ok",
        message: `Sid's PC has never checked in. ${pending} job(s) are waiting for it.`,
        data: { online: false, ever_seen: false, pending_jobs: pending },
      };
    }
    return {
      ok: true,
      status: "ok",
      message:
        `Sid's PC is ${state.online ? "online" : `offline (last checked in ${state.secondsAgo}s ago)`}` +
        `${state.heartbeat.version ? `, agent ${state.heartbeat.version}` : ""}. ${pending} job(s) waiting.`,
      data: {
        online: state.online,
        ever_seen: true,
        last_seen: state.heartbeat.lastSeen,
        seconds_ago: state.secondsAgo,
        ...(state.heartbeat.version ? { agent_version: state.heartbeat.version } : {}),
        pending_jobs: pending,
      },
    };
  },
};

export const pcTools: Tool[] = [pcStatus, pcExecute];

/** Enqueue helper for spend_money (confirmed action → browser autofill job). */
export async function enqueueSpendJob(
  pc: NonNullable<ToolContext["pc"]>,
  args: { url: string; amount: number; currency: string; description: string },
): Promise<{ id: string }> {
  const job = await pc.jobs.enqueue("browser", {
    url: args.url,
    instructions:
      "Complete the checkout using Sid's saved card ending 2286 via browser autofill. Do NOT invent card details; " +
      "if autofill cannot be used, report that honestly and leave the page open for Sid.",
    amount: args.amount,
    currency: args.currency,
    description: args.description,
    spend: true,
  });
  return { id: job.id };
}
