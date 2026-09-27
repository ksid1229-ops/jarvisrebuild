import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { num, optStr, str } from "../persistence/d1.js";
import type { ConversationStore, ReviewWindow } from "../conversation/conversation-repo.js";
import type { AgentResult, JarvisEvent } from "../jarvis/agent-core.js";
import type { Model } from "../model/types.js";
import type { StoredMessage } from "../types.js";
import { wakeupEvent } from "../scheduler/cron.js";

/**
 * Memory reviews (brief Phase 2: "auto-extraction wake-ups").
 *
 * Code's whole job here is SENSES + PROOF: notice that there is conversation the
 * model has not reviewed yet, wake it with exactly those messages (ids included,
 * so it can cite them as stated-fact sources), and write down what happened.
 * WHAT is worth remembering, how long it lasts, whether it corrects something —
 * all of that is the model's decision inside the review turn.
 *
 * Two senses wake a review:
 *  - quiet_alarm: after each live exchange a timer is (re)armed; when the
 *    conversation has been quiet that long, the DO alarm fires the review.
 *  - hourly_cron: the hourly run reviews anything still unreviewed (catches a
 *    failed quiet review, and messages that arrived while no timer was armed).
 *
 * The cursor only advances on a SUCCESSFUL run, so a model error means the same
 * window is reviewed again next time — never silently skipped.
 */

export type ReviewTrigger = "quiet_alarm" | "hourly_cron";
export type RunStatus = "running" | "ok" | "nothing_new" | "error";

export interface MemoryRun {
  id: string;
  trigger: ReviewTrigger;
  model: string;
  windowStart: string | null;
  windowEnd: string | null;
  messagesReviewed: number;
  messagesDeferred: number;
  factsSaved: number;
  factsCorrected: number;
  status: RunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StartRunInput {
  trigger: ReviewTrigger;
  model: string;
  windowStart: string | null;
  windowEnd: string | null;
  messagesReviewed: number;
  messagesDeferred: number;
}

export interface FinishRunInput {
  status: Exclude<RunStatus, "running">;
  factsSaved: number;
  factsCorrected: number;
  error: string | null;
}

export interface MemoryRunsStore {
  start(input: StartRunInput): Promise<MemoryRun>;
  finish(id: string, input: FinishRunInput): Promise<MemoryRun>;
  /** window_end of the latest SUCCESSFUL run (status ok), or null if none. */
  cursor(): Promise<string | null>;
  /** Newest first. */
  recent(limit: number): Promise<MemoryRun[]>;
  all(): Promise<MemoryRun[]>;
}

export class MemoryRunsRepo implements MemoryRunsStore {
  private readonly runs: MemoryRun[] = [];
  constructor(private readonly clock: Clock) {}

  async start(input: StartRunInput): Promise<MemoryRun> {
    const run: MemoryRun = {
      id: newId("mrun"),
      ...input,
      factsSaved: 0,
      factsCorrected: 0,
      status: "running",
      error: null,
      startedAt: this.clock.nowIso(),
      finishedAt: null,
    };
    this.runs.push(run);
    return { ...run };
  }

  async finish(id: string, input: FinishRunInput): Promise<MemoryRun> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new Error(`memory run ${id} does not exist`);
    Object.assign(run, input, { finishedAt: this.clock.nowIso() });
    return { ...run };
  }

  async cursor(): Promise<string | null> {
    let best: string | null = null;
    for (const r of this.runs) {
      if (r.status === "ok" && r.windowEnd && (best === null || r.windowEnd > best)) best = r.windowEnd;
    }
    return best;
  }

  async recent(limit: number): Promise<MemoryRun[]> {
    return [...this.runs].reverse().slice(0, limit).map((r) => ({ ...r }));
  }

  async all(): Promise<MemoryRun[]> {
    return this.runs.map((r) => ({ ...r }));
  }
}

function rowToRun(row: D1Row): MemoryRun {
  return {
    id: str(row.id, "memory_runs.id"),
    trigger: str(row.trigger, "memory_runs.trigger") as ReviewTrigger,
    model: str(row.model, "memory_runs.model"),
    windowStart: optStr(row.window_start, "memory_runs.window_start"),
    windowEnd: optStr(row.window_end, "memory_runs.window_end"),
    messagesReviewed: num(row.messages_reviewed, "memory_runs.messages_reviewed"),
    messagesDeferred: num(row.messages_deferred, "memory_runs.messages_deferred"),
    factsSaved: num(row.facts_saved, "memory_runs.facts_saved"),
    factsCorrected: num(row.facts_corrected, "memory_runs.facts_corrected"),
    status: str(row.status, "memory_runs.status") as RunStatus,
    error: optStr(row.error, "memory_runs.error"),
    startedAt: str(row.started_at, "memory_runs.started_at"),
    finishedAt: optStr(row.finished_at, "memory_runs.finished_at"),
  };
}

export class D1MemoryRunsRepo implements MemoryRunsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async start(input: StartRunInput): Promise<MemoryRun> {
    const id = newId("mrun");
    await this.db
      .prepare(
        `INSERT INTO memory_runs (id, trigger, model, window_start, window_end, messages_reviewed,
         messages_deferred, facts_saved, facts_corrected, status, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'running', NULL, ?, NULL)`,
      )
      .bind(
        id, input.trigger, input.model, input.windowStart, input.windowEnd, input.messagesReviewed,
        input.messagesDeferred, this.clock.nowIso(),
      )
      .run();
    return this.mustGet(id);
  }

  async finish(id: string, input: FinishRunInput): Promise<MemoryRun> {
    await this.db
      .prepare(
        `UPDATE memory_runs SET status = ?, facts_saved = ?, facts_corrected = ?, error = ?, finished_at = ?
         WHERE id = ?`,
      )
      .bind(input.status, input.factsSaved, input.factsCorrected, input.error, this.clock.nowIso(), id)
      .run();
    return this.mustGet(id);
  }

  async cursor(): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT MAX(window_end) AS c FROM memory_runs WHERE status = 'ok'`)
      .first<D1Row>();
    return optStr(row?.c, "cursor");
  }

  async recent(limit: number): Promise<MemoryRun[]> {
    const res = await this.db
      .prepare(`SELECT * FROM memory_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`)
      .bind(limit)
      .all<D1Row>();
    return res.results.map(rowToRun);
  }

  async all(): Promise<MemoryRun[]> {
    const res = await this.db.prepare(`SELECT * FROM memory_runs ORDER BY rowid ASC`).all<D1Row>();
    return res.results.map(rowToRun);
  }

  private async mustGet(id: string): Promise<MemoryRun> {
    const row = await this.db.prepare(`SELECT * FROM memory_runs WHERE id = ?`).bind(id).first<D1Row>();
    if (!row) throw new Error(`memory run ${id} does not exist`);
    return rowToRun(row);
  }
}

/** System-protection limits. Anything they cut is REPORTED in the instruction and the run row. */
export const REVIEW_MESSAGE_CAP = 200;
export const REVIEW_MESSAGE_CHARS = 4000;
/** How long a conversation must be quiet before the review alarm fires. A wake-up cadence, not a judgment. */
export const MEMORY_REVIEW_QUIET_MS = 20 * 60 * 1000;

function transcriptLine(m: StoredMessage): string {
  const who = m.role === "user" ? (m.forwarded ? "Sid (FORWARDED text, not his own words)" : "Sid") : "Jarvis";
  const body =
    m.content.length > REVIEW_MESSAGE_CHARS
      ? `${m.content.slice(0, REVIEW_MESSAGE_CHARS)} […${m.content.length - REVIEW_MESSAGE_CHARS} more characters cut for size; history_search shows the full message]`
      : m.content;
  return `[${m.id}] ${m.createdAt} (${m.channel === "voice" ? "call" : "text"}) ${who}: ${body}`;
}

export function buildReviewInstruction(trigger: ReviewTrigger, win: ReviewWindow): string {
  const why = trigger === "quiet_alarm" ? "the conversation went quiet" : "the hourly review";
  const lines = win.messages.map(transcriptLine);
  const deferred =
    win.deferred > 0
      ? ` ${win.deferred} newer message(s) did not fit this review and will be in the next one.`
      : "";
  return [
    `memory review (${why}). Below are the ${win.messages.length} message(s) you have not reviewed yet, oldest first.${deferred}`,
    "Decide what, if anything, is worth remembering about Sid and his world, and save it with memory_save or memory_correct.",
    "Saving nothing is a valid outcome. Check memory_search first if you might already know it.",
    "For something Sid said himself, use confidence 'stated' with his exact words as quote and the id in brackets as source_message_id. A forwarded text is not his own words.",
    "This is a background review: Sid is not waiting for a reply. Whether anything here is worth messaging him about is your call.",
    "",
    ...lines,
  ].join("\n");
}

export interface ReviewAgent {
  handle(event: JarvisEvent, opts?: { model?: Model }): Promise<AgentResult>;
}

export interface MemoryReviewerDeps {
  conversation: ConversationStore;
  runs: MemoryRunsStore;
  agent: ReviewAgent;
  /** Name recorded on each run (the extraction model if configured, else the main model). */
  modelName: string;
  /** MEMORY_EXTRACTION_MODEL: when set, reviews run on it; otherwise on the main model. */
  extractionModel?: Model;
}

export class MemoryReviewer {
  constructor(private readonly d: MemoryReviewerDeps) {}

  async run(trigger: ReviewTrigger): Promise<MemoryRun> {
    const cursor = await this.d.runs.cursor();
    const win = await this.d.conversation.since(cursor, REVIEW_MESSAGE_CAP);
    const first = win.messages[0];
    const last = win.messages[win.messages.length - 1];
    const run = await this.d.runs.start({
      trigger,
      model: this.d.modelName,
      windowStart: first?.createdAt ?? null,
      windowEnd: last?.createdAt ?? null,
      messagesReviewed: win.messages.length,
      messagesDeferred: win.deferred,
    });
    if (win.messages.length === 0) {
      return this.d.runs.finish(run.id, { status: "nothing_new", factsSaved: 0, factsCorrected: 0, error: null });
    }

    let result: AgentResult;
    try {
      result = await this.d.agent.handle(
        wakeupEvent(buildReviewInstruction(trigger, win)),
        this.d.extractionModel ? { model: this.d.extractionModel } : {},
      );
    } catch (e) {
      return this.d.runs.finish(run.id, { status: "error", factsSaved: 0, factsCorrected: 0, error: (e as Error).message });
    }
    const saved = result.toolCalls.filter((c) => c.name === "memory_save" && c.ok).length;
    const corrected = result.toolCalls.filter((c) => c.name === "memory_correct" && c.ok).length;
    if (result.error) {
      return this.d.runs.finish(run.id, { status: "error", factsSaved: saved, factsCorrected: corrected, error: result.error });
    }
    return this.d.runs.finish(run.id, { status: "ok", factsSaved: saved, factsCorrected: corrected, error: null });
  }
}
