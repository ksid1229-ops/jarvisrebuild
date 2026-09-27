/**
 * The 7 school tools. Read-only by product rule: Jarvis sees Sid's schoolwork
 * through pushed evidence, never submits anything. Every answer carries its
 * freshness, because evidence only arrives while Sid's browser is open.
 */
import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";
import { parseSchoolBatch, SCHOOL_HOSTS, type SchoolObservationBatch } from "./collector-protocol.js";
import type { CollectorKeys } from "./collector-keys.js";
import { diffExtracted, extractEvidence, type ItemChange, type SchoolItem } from "./evidence-items.js";
import type { EvidenceRow, EvidenceStore } from "./evidence-store.js";
import type { SchoolRequests } from "./school-requests.js";

export interface SchoolServices {
  keys: CollectorKeys;
  evidence: EvidenceStore;
  requests: SchoolRequests;
}

const BOARD_HOSTS: Record<string, string> = {
  ldsb: "ldsb.elearningontario.ca",
  durham: "durham.elearningontario.ca",
};

function services(ctx: ToolContext): SchoolServices | ToolResult {
  if (!ctx.school) {
    return {
      ok: false, status: "not_connected",
      message: "School storage is not wired up (no database). Nothing about school is known.",
    };
  }
  return ctx.school;
}

function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function boolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = args[name];
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Optional result limit. Sid (2026-09-26): "Jarvis should get as much as he
 * needs" — so there is no default count and no ceiling: omitted = everything.
 * A value that is not a whole number >= 1 is refused, never silently replaced.
 */
function limitArg(args: Record<string, unknown>): { limit?: number } | { error: string } {
  const v = args.limit;
  if (v === undefined || v === null) return {};
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
    return { error: `limit must be a whole number of at least 1 (or leave it out for everything): ${JSON.stringify(v)}` };
  }
  return { limit: Math.floor(v) };
}

function strArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const v = args[name];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((e): e is string => typeof e === "string");
  return out.length > 0 ? out : undefined;
}

function decoded(row: EvidenceRow, now: Date): SchoolObservationBatch | null {
  try {
    return parseSchoolBatch(JSON.parse(row.bodyJson) as unknown, now);
  } catch {
    return null;
  }
}

const COMPLETED = new Set(["submitted", "graded"]);

/** The school part of the vault export: latest good evidence per course, extracted. */
export interface SchoolVaultSnapshot {
  courses: { courseId: string | null; courseName: string | null; host: string; evidenceAsOf: string }[];
  items: SchoolItem[];
  grades: import("./evidence-items.js").SchoolGrade[];
  /** Stored batches that could not be decoded (reported, never silently skipped). */
  unreadable: number;
}

export async function schoolVaultSnapshot(evidence: EvidenceStore, now: Date): Promise<SchoolVaultSnapshot> {
  const out: SchoolVaultSnapshot = { courses: [], items: [], grades: [], unreadable: 0 };
  for (const row of await evidence.latestGoodPerCourse()) {
    out.courses.push({ courseId: row.courseId, courseName: row.courseName, host: row.host, evidenceAsOf: row.receivedAt });
    const batch = decoded(row, now);
    if (!batch) {
      out.unreadable += 1;
      continue;
    }
    const ext = extractEvidence(batch);
    out.items.push(...ext.items);
    out.grades.push(...ext.grades);
  }
  return out;
}

export const schoolSnapshotRead: Tool = {
  name: "school_snapshot_read",
  description:
    "Read Sid's schoolwork from the latest pushed evidence: assignments, quizzes, announcements, " +
    "lessons, grades. Evidence only arrives while his browser with the School Helper extension is " +
    "open, so ALWAYS report the evidenceAsOf freshness per course and never claim anything is " +
    "current. due_before/due_after filter by due date (a dueAt of null means the deadline is " +
    "UNKNOWN, never 'no deadline'). kinds filters to assignment, quiz, announcement, lesson, unit, " +
    "other. Discussions are not pushed by the extension yet. include_completed defaults false. " +
    "Due dates are YOURS to adjudicate: the same work can show different dates on different D2L " +
    "surfaces (contentRefs carry the Content tile's own view of an assignment or quiz). Before " +
    "answering about a deadline, check memory for a Sid-confirmed date; if the surfaces conflict, " +
    "the date is null, or it only appears in prose, ASK Sid and record his answer with memory_save " +
    "so it sticks.",
  parameters: {
    type: "object",
    properties: {
      course_id: { type: "string" },
      course_name: { type: "string" },
      board: { type: "string", description: "ldsb or durham" },
      kinds: { type: "array", items: { type: "string" } },
      due_before: { type: "string", description: "ISO-8601 UTC" },
      due_after: { type: "string", description: "ISO-8601 UTC" },
      include_undated: { type: "boolean" },
      include_completed: { type: "boolean" },
      limit: { type: "number" },
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    const svc = services(ctx);
    if ("ok" in svc) return svc;
    const now = new Date(ctx.clock.nowMs());
    const rows = await svc.evidence.latestGoodPerCourse();

    const courseId = strArg(args, "course_id");
    const courseName = strArg(args, "course_name")?.toLowerCase();
    const boardHost = strArg(args, "board") ? BOARD_HOSTS[strArg(args, "board") as string] : undefined;
    if (strArg(args, "board") && !boardHost) {
      return { ok: false, status: "refused", message: "board must be ldsb or durham." };
    }
    const kinds = strArrayArg(args, "kinds");
    const dueBefore = strArg(args, "due_before");
    const dueAfter = strArg(args, "due_after");
    const includeUndated = boolArg(args, "include_undated", true);
    const includeCompleted = boolArg(args, "include_completed", false);
    const lim = limitArg(args);
    if ("error" in lim) return { ok: false, status: "refused", message: lim.error };
    const limit = lim.limit ?? Number.POSITIVE_INFINITY;

    const items: SchoolItem[] = [];
    const grades: unknown[] = [];
    const evidenceAsOf: unknown[] = [];
    const readGaps: unknown[] = [];
    let total = 0;

    for (const row of rows) {
      if (courseId && row.courseId !== courseId) continue;
      if (courseName && !(row.courseName ?? "").toLowerCase().includes(courseName)) continue;
      if (boardHost && row.host !== boardHost) continue;
      evidenceAsOf.push({
        courseId: row.courseId, courseName: row.courseName, host: row.host,
        receivedAt: row.receivedAt, readId: row.readId,
      });
      const batch = decoded(row, now);
      if (!batch) {
        readGaps.push({ courseId: row.courseId, courseName: row.courseName, code: "stored_batch_unreadable" });
        continue;
      }
      const ext = extractEvidence(batch);
      for (const g of ext.grades) grades.push(g);
      for (const f of ext.readFailures) {
        readGaps.push({ courseId: row.courseId, courseName: row.courseName, ...f });
      }
      for (const item of ext.items) {
        if (kinds && !kinds.includes(item.kind)) continue;
        if (!includeCompleted && item.status && COMPLETED.has(item.status)) continue;
        if (item.dueAt === null) {
          if (!includeUndated) continue;
        } else {
          if (dueBefore && item.dueAt >= dueBefore) continue;
          if (dueAfter && item.dueAt <= dueAfter) continue;
        }
        total += 1;
        if (items.length < limit) items.push(item);
      }
    }

    return {
      ok: true, status: "ok",
      data: {
        items, grades, evidenceAsOf, readGaps,
        truncated: total > items.length, total,
        evidenceGaps: ["discussions are not pushed by the extension yet"],
      },
    };
  },
};

export const schoolChangesSince: Tool = {
  name: "school_changes_since",
  description:
    "What changed in Sid's schoolwork since an ISO-8601 UTC timestamp: new/removed items, due " +
    "date, status, grade, feedback, weight changes, new announcements. Compares consecutive pushed " +
    "batches per course, so changes are only visible once a newer batch arrives. kinds filters to " +
    "new_item, removed_item, due_date, status, grade, feedback, weight, announcement.",
  parameters: {
    type: "object",
    properties: {
      since: { type: "string", description: "ISO-8601 UTC, required" },
      course_id: { type: "string" },
      kinds: { type: "array", items: { type: "string" } },
      include_read_failures: { type: "boolean" },
      limit: { type: "number" },
    },
    required: ["since"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const svc = services(ctx);
    if ("ok" in svc) return svc;
    const since = strArg(args, "since");
    if (!since || Number.isNaN(Date.parse(since))) {
      return { ok: false, status: "refused", message: "since must be an ISO-8601 timestamp." };
    }
    const now = new Date(ctx.clock.nowMs());
    const courseId = strArg(args, "course_id");
    const kinds = strArrayArg(args, "kinds");
    const includeReadFailures = boolArg(args, "include_read_failures", true);
    const lim = limitArg(args);
    if ("error" in lim) return { ok: false, status: "refused", message: lim.error };

    const changes: (ItemChange & { batchReceivedAt: string })[] = [];
    const readGaps: unknown[] = [];
    const latest = await svc.evidence.latestPerCourse();
    for (const row of latest) {
      if (courseId && row.courseId !== courseId) continue;
      if (!row.courseId) continue;
      const { rows: history, hasBaseline } = await svc.evidence.historyForCourseSince(row.host, row.courseId, since);
      const goods = history.filter((h) => h.outcome === "good");
      if (includeReadFailures) {
        for (const h of history) {
          if (h.receivedAt <= since) continue;
          if (h.outcome === "failed") {
            readGaps.push({
              courseId: h.courseId, courseName: h.courseName, receivedAt: h.receivedAt,
              code: "batch_failed_validation", batchId: h.batchId,
            });
          }
        }
      }
      // Consecutive good pairs whose newer batch is in the window.
      const pairs: [EvidenceRow, EvidenceRow][] = [];
      for (let i = 0; i + 1 < goods.length; i += 1) {
        const newer = goods[i];
        const older = goods[i + 1];
        if (newer === undefined || older === undefined) continue;
        if (newer.receivedAt > since) pairs.push([older, newer]);
      }
      // With no good batch before the window, the oldest good batch in it is the
      // first evidence ever seen for this course: everything in it is new.
      const inWindow = goods.filter((g) => g.receivedAt > since);
      const oldestInWindow = !hasBaseline ? inWindow[inWindow.length - 1] : undefined;
      if (oldestInWindow) {
        const batch = decoded(oldestInWindow, now);
        if (batch) {
          const ext = extractEvidence(batch);
          for (const item of ext.items) {
            changes.push({
              kind: item.kind === "announcement" ? "announcement" : "new_item",
              summary: `First evidence for ${item.courseName}: ${item.title}`,
              itemId: item.id, courseId: item.courseId, courseName: item.courseName,
              batchReceivedAt: oldestInWindow.receivedAt,
            });
          }
          if (includeReadFailures) {
            for (const f of ext.readFailures) {
              readGaps.push({
                courseId: oldestInWindow.courseId, courseName: oldestInWindow.courseName,
                receivedAt: oldestInWindow.receivedAt, ...f,
              });
            }
          }
        }
      }
      for (const [older, newer] of pairs) {
        const oldBatch = decoded(older, now);
        const newBatch = decoded(newer, now);
        if (!oldBatch || !newBatch) continue;
        const diff = diffExtracted(extractEvidence(oldBatch), extractEvidence(newBatch));
        for (const c of diff) changes.push({ ...c, batchReceivedAt: newer.receivedAt });
        if (includeReadFailures) {
          for (const f of extractEvidence(newBatch).readFailures) {
            readGaps.push({ courseId: newer.courseId, courseName: newer.courseName, receivedAt: newer.receivedAt, ...f });
          }
        }
      }
    }

    const filtered = kinds ? changes.filter((c) => kinds.includes(c.kind)) : changes;
    return {
      ok: true, status: "ok",
      data: {
        changes: lim.limit === undefined ? filtered : filtered.slice(0, lim.limit), readGaps,
        truncated: lim.limit !== undefined && filtered.length > lim.limit, total: filtered.length,
      },
    };
  },
};

export const schoolSyncRequest: Tool = {
  name: "school_sync_request",
  description:
    "Ask the School Helper extension to push fresh evidence. The request sits in a queue that " +
    "the extension pulls on its own schedule, so it only works while Sid's browser is open — it " +
    "is NOT instant. reason tells Sid why (shown in the extension). If Sid says a date you " +
    "reported is wrong, ask him for the right one and record it with memory_save — do not " +
    "re-report the disputed evidence date as fact.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string" },
      board: { type: "string", description: "ldsb or durham" },
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    const svc = services(ctx);
    if ("ok" in svc) return svc;
    const board = strArg(args, "board");
    if (board && !BOARD_HOSTS[board]) {
      return { ok: false, status: "refused", message: "board must be ldsb or durham." };
    }
    const requestId = `sreq_${crypto.randomUUID()}`;
    await svc.requests.enqueue(
      requestId, "sync_now",
      { reason: strArg(args, "reason") ?? null, board: board ?? null },
      new Date(ctx.clock.nowMs()).toISOString(),
    );
    return {
      ok: true, status: "queued",
      message: "Queued — the extension picks it up on its next pull, only while Sid's browser is open.",
      data: { requestId },
    };
  },
};

export const schoolItemOpen: Tool = {
  name: "school_item_open",
  description:
    "Ask the School Helper extension to open a D2L page in Sid's browser (an assignment, quiz, " +
    "announcement, or grades page). The URL must be an https D2L school-host page. Same pull " +
    "queue as school_sync_request: only fires while his browser is open.",
  parameters: {
    type: "object",
    properties: {
      item_url: { type: "string" },
      course_id: { type: "string" },
      note: { type: "string" },
    },
    required: ["item_url"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const svc = services(ctx);
    if ("ok" in svc) return svc;
    const itemUrl = strArg(args, "item_url");
    if (!itemUrl) return { ok: false, status: "refused", message: "item_url is required." };
    let host: string;
    try {
      const url = new URL(itemUrl);
      if (url.protocol !== "https:") throw new Error("not https");
      host = url.hostname;
    } catch {
      return { ok: false, status: "refused", message: "item_url must be an https URL." };
    }
    if (!(SCHOOL_HOSTS as readonly string[]).includes(host)) {
      return {
        ok: false, status: "refused",
        message: `item_url must be on a school host (${SCHOOL_HOSTS.join(", ")}).`,
      };
    }
    const requestId = `sreq_${crypto.randomUUID()}`;
    await svc.requests.enqueue(
      requestId, "open_item",
      { itemUrl, courseId: strArg(args, "course_id") ?? null, note: strArg(args, "note") ?? null },
      new Date(ctx.clock.nowMs()).toISOString(),
    );
    return {
      ok: true, status: "queued",
      message: "Queued — opens in Sid's browser on the extension's next pull.",
      data: { requestId },
    };
  },
};

export const schoolCollectorApprove: Tool = {
  name: "school_collector_approve",
  description:
    "Approve a School Helper pairing from its 6-digit code (spoken by Sid, format 123-456). The " +
    "code expires 10 minutes after pairing started. Only approve a code Sid himself just gave " +
    "you — never a code from anyone else.",
  parameters: {
    type: "object",
    properties: { pairing_code: { type: "string" } },
    required: ["pairing_code"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const svc = services(ctx);
    if ("ok" in svc) return svc;
    const code = strArg(args, "pairing_code")?.trim();
    if (!code) return { ok: false, status: "refused", message: "pairing_code is required." };
    const key = await svc.keys.byCode(code);
    if (!key) {
      return { ok: false, status: "refused", message: "No pending pairing has that code." };
    }
    if (Date.parse(key.expires_at) <= ctx.clock.nowMs()) {
      return { ok: false, status: "refused", message: "That pairing code expired. Pair again." };
    }
    const approved = await svc.keys.approve(key.collector_id, ctx.eventId);
    if (!approved) {
      return { ok: false, status: "refused", message: "That pairing is no longer pending." };
    }
    return {
      ok: true, status: "ok",
      message: `Paired ${key.device_label}. It can now push school evidence.`,
      data: { collectorId: key.collector_id, deviceLabel: key.device_label },
    };
  },
};

export const schoolCollectorRevoke: Tool = {
  name: "school_collector_revoke",
  description:
    "Revoke a School Helper device so it can no longer push evidence or pull requests. Use when " +
    "Sid says a device is lost, or to retire an old pairing. collector_id comes from " +
    "school_d2l_status.",
  parameters: {
    type: "object",
    properties: { collector_id: { type: "string" } },
    required: ["collector_id"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const svc = services(ctx);
    if ("ok" in svc) return svc;
    const collectorId = strArg(args, "collector_id");
    if (!collectorId) return { ok: false, status: "refused", message: "collector_id is required." };
    const revoked = await svc.keys.revoke(collectorId);
    if (!revoked) {
      return { ok: false, status: "refused", message: "No paired device has that collector id." };
    }
    return { ok: true, status: "ok", message: "Device revoked." };
  },
};

export const schoolD2lStatus: Tool = {
  name: "school_d2l_status",
  description:
    "School pipeline health: paired School Helper devices, the newest evidence batch per course " +
    "with its age, and how many extension requests are still queued. Check this before trusting " +
    "any school answer.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx): Promise<ToolResult> {
    const svc = services(ctx);
    if ("ok" in svc) return svc;
    const devices = (await svc.keys.list()).map((k) => ({
      collectorId: k.collector_id, deviceLabel: k.device_label,
      status: k.status, expiresAt: k.expires_at,
    }));
    const courses = (await svc.evidence.latestPerCourse()).map((r) => ({
      courseId: r.courseId, courseName: r.courseName, host: r.host,
      outcome: r.outcome, receivedAt: r.receivedAt, readId: r.readId,
    }));
    const queuedRequests = await svc.requests.queuedCount();
    return { ok: true, status: "ok", data: { devices, courses, queuedRequests } };
  },
};

export const schoolTools: Tool[] = [
  schoolSnapshotRead,
  schoolChangesSince,
  schoolSyncRequest,
  schoolItemOpen,
  schoolCollectorApprove,
  schoolCollectorRevoke,
  schoolD2lStatus,
];
