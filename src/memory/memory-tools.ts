import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";
import { ProvenanceError, resolveStatedSource } from "./provenance.js";
import { SupersededFactError } from "./facts-repo.js";
import type { Channel, Fact, FactConfidence, FactKind } from "../types.js";

const KINDS: FactKind[] = ["durable", "temporary"];
const CONFIDENCES: FactConfidence[] = ["stated", "inferred", "confirmed"];
const CHANNELS: Channel[] = ["text", "voice"];

function refused(message: string): ToolResult {
  return { ok: false, status: "refused", message };
}

function badEnum(field: string, value: unknown, allowed: string[]): ToolResult {
  return refused(`${field} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}. Not defaulted.`);
}

/** Validation only: a positive whole number the MODEL chose. Returns null if invalid. */
function modelLimit(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return null;
  return Math.floor(v);
}

/** Validation only: an RFC3339-parsable instant, normalized to UTC ms. */
function realInstant(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Index a fact for meaning search. The fact is already safely in the ledger; if
 * the index is down, say so (the hourly re-index retries) rather than failing
 * the save or pretending it is searchable.
 */
async function indexFact(ctx: ToolContext, fact: Fact): Promise<string | null> {
  try {
    const vector = await ctx.embeddings.embed(fact.text);
    await ctx.vectors.upsert(fact.id, vector);
    await ctx.facts.markIndexed(fact.id, true);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Remove a fact from the meaning index; an error is reported, never swallowed. */
async function unindexFact(ctx: ToolContext, id: string): Promise<string | null> {
  try {
    await ctx.vectors.remove(id);
    await ctx.facts.markIndexed(id, false);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function withIndexNote(base: ToolResult, indexError: string | null): ToolResult {
  if (!indexError) return base;
  return {
    ...base,
    message: `${base.message ?? ""} Saved in the ledger but NOT yet in meaning search (${indexError}); the hourly re-index will retry. history and memory_explain still see it.`.trim(),
    data: { ...(base.data as object), indexed: false, indexError },
  };
}

type Source = { sourceMessageId: string | null } | { error: ToolResult };

/**
 * Where a fact comes from. Provenance is code's job (a fact the model cannot
 * see for itself); whether the fact is worth saving is the model's.
 */
async function resolveSource(args: Record<string, unknown>, confidence: FactConfidence, ctx: ToolContext): Promise<Source> {
  const cited = typeof args.source_message_id === "string" && args.source_message_id !== "" ? args.source_message_id : undefined;
  if (confidence === "stated") {
    if (typeof args.quote !== "string") return { error: refused("A stated fact requires quote (Sid's exact words).") };
    try {
      const src = await resolveStatedSource(args.quote, cited, ctx);
      return { sourceMessageId: src.messageId };
    } catch (e) {
      if (e instanceof ProvenanceError) return { error: refused(e.message) };
      throw e;
    }
  }
  if (cited !== undefined) {
    if (!(await ctx.conversation.get(cited))) return { error: refused(`source_message_id ${cited} does not exist.`) };
    return { sourceMessageId: cited };
  }
  return { sourceMessageId: ctx.currentMessageId ?? null };
}

const SOURCE_DOC =
  "source_message_id: optional — the id of the message this rests on (history_search results and " +
  "memory-review transcripts show ids like msg_...). Needed for a stated fact when you are not " +
  "replying to that message right now, e.g. during a review. ";

export const memorySave: Tool = {
  name: "memory_save",
  description:
    "Save one thing worth remembering about Sid or his world. Call it whenever you notice " +
    "something durable or useful — you do NOT wait to be told to remember. " +
    "text: the fact in your own clear words. " +
    "kind: 'durable' for things that stay true (he has an iPhone 16), 'temporary' for things " +
    "that expire (he's away this weekend) — a temporary fact REQUIRES expires_at as an RFC3339 " +
    "UTC instant. " +
    "confidence: 'stated' if Sid said it (you MUST also pass quote: his exact words, which must " +
    "appear in his message — forwarded texts are not his words), 'inferred' if you concluded it, " +
    "'confirmed' only once Sid confirms an inference. confidence is required and never defaulted. " +
    SOURCE_DOC +
    "Example: memory_save(text='Sid hates mornings', kind='durable', confidence='stated', " +
    "quote='i hate mornings').",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The fact, in your words." },
      kind: { type: "string", enum: KINDS, description: "durable or temporary" },
      confidence: { type: "string", enum: CONFIDENCES, description: "stated | inferred | confirmed" },
      quote: { type: "string", description: "Required when confidence='stated': Sid's exact words." },
      source_message_id: { type: "string", description: "Optional: the msg_... id this fact rests on." },
      expires_at: { type: "string", description: "Required when kind='temporary': RFC3339 UTC instant." },
      pinned: { type: "boolean", description: "Set true only for core-profile facts." },
    },
    required: ["text", "kind", "confidence"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const text = args.text;
    if (typeof text !== "string" || text.trim() === "") return refused("text is required.");
    const kind = args.kind as FactKind;
    if (!KINDS.includes(kind)) return badEnum("kind", args.kind, KINDS);
    const confidence = args.confidence as FactConfidence;
    if (!CONFIDENCES.includes(confidence)) return badEnum("confidence", args.confidence, CONFIDENCES);

    let expiresAt: string | null = null;
    if (kind === "temporary") {
      if (typeof args.expires_at !== "string") {
        return refused("A temporary fact requires expires_at (RFC3339 UTC). Refused rather than defaulted.");
      }
      expiresAt = realInstant(args.expires_at);
      if (!expiresAt) return refused(`expires_at is not a real date: ${args.expires_at}`);
    }

    const source = await resolveSource(args, confidence, ctx);
    if ("error" in source) return source.error;

    const fact = await ctx.facts.save({
      text,
      kind,
      confidence,
      sourceType: ctx.provenance.sourceType,
      sourceRef: ctx.provenance.sourceRef,
      sourceMessageId: source.sourceMessageId,
      expiresAt,
      pinned: args.pinned === true,
    });
    const indexError = await indexFact(ctx, fact);
    return withIndexNote({ ok: true, status: "ok", message: `Saved fact ${fact.id}`, data: { id: fact.id } }, indexError);
  },
};

export const memoryCorrect: Tool = {
  name: "memory_correct",
  description:
    "Replace an existing fact with a corrected version, linking the new to the old (nothing is " +
    "overwritten; the history stays). Use when a new statement supersedes an old one. You state " +
    "the replacement's kind, confidence and (if temporary) expires_at — pass the same values if " +
    "only the wording changed. reason: why it changed (kept on the new version and shown by " +
    "memory_explain). The new version's source is THIS turn (or source_message_id), not the old " +
    "fact's; a 'stated' correction needs quote exactly like memory_save. Only the current version " +
    "can be corrected — if you pass an outdated one you will be told the current id. " +
    SOURCE_DOC,
  parameters: {
    type: "object",
    properties: {
      fact_id: { type: "string" },
      new_text: { type: "string" },
      confidence: { type: "string", enum: CONFIDENCES },
      kind: { type: "string", enum: KINDS },
      expires_at: { type: "string", description: "Required when kind='temporary'." },
      quote: { type: "string", description: "Required when confidence='stated': Sid's exact words." },
      source_message_id: { type: "string", description: "Optional: the msg_... id this correction rests on." },
      reason: { type: "string" },
    },
    required: ["fact_id", "new_text", "confidence", "kind", "reason"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const fact = await ctx.facts.get(String(args.fact_id));
    if (!fact) return refused(`fact ${args.fact_id} does not exist.`);
    const newText = args.new_text;
    if (typeof newText !== "string" || newText.trim() === "") return refused("new_text is required.");
    const reason = args.reason;
    if (typeof reason !== "string" || reason.trim() === "") return refused("reason is required. Not defaulted.");
    const kind = args.kind as FactKind;
    if (!KINDS.includes(kind)) return badEnum("kind", args.kind, KINDS);
    const confidence = args.confidence as FactConfidence;
    if (!CONFIDENCES.includes(confidence)) return badEnum("confidence", args.confidence, CONFIDENCES);
    let expiresAt: string | null = null;
    if (kind === "temporary") {
      expiresAt = realInstant(args.expires_at);
      if (!expiresAt) return refused("A temporary correction requires a real expires_at.");
    }
    const source = await resolveSource(args, confidence, ctx);
    if ("error" in source) return source.error;

    let next: Fact;
    try {
      next = await ctx.facts.correct(fact.id, {
        text: newText,
        kind,
        confidence,
        expiresAt,
        reason,
        sourceType: ctx.provenance.sourceType,
        sourceRef: ctx.provenance.sourceRef,
        sourceMessageId: source.sourceMessageId,
      });
    } catch (e) {
      if (e instanceof SupersededFactError) {
        return { ok: false, status: "refused", message: e.message, data: { currentId: e.currentId } };
      }
      throw e;
    }
    const removeError = await unindexFact(ctx, fact.id);
    const indexError = await indexFact(ctx, next);
    const base: ToolResult = { ok: true, status: "ok", message: `Corrected into ${next.id}`, data: { id: next.id } };
    if (removeError) {
      base.message += ` (the old version could not be removed from the meaning index: ${removeError}; search still hides it because it is superseded)`;
    }
    return withIndexNote(base, indexError);
  },
};

function simpleFactTool(
  name: string,
  description: string,
  op: (ctx: ToolContext, id: string) => Promise<ToolResult> | ToolResult,
): Tool {
  return {
    name,
    description,
    parameters: { type: "object", properties: { fact_id: { type: "string" } }, required: ["fact_id"] },
    async run(args, ctx): Promise<ToolResult> {
      const id = String(args.fact_id);
      if (!(await ctx.facts.get(id))) return { ok: false, status: "refused", message: `fact ${id} does not exist.` };
      return op(ctx, id);
    },
  };
}

export const memoryForget = simpleFactTool(
  "memory_forget",
  "Hide a fact from recall (reversible with memory_restore). Use when Sid asks to forget something. " +
    "It hides the FACT: it stops appearing in your core profile and memory_search. The original " +
    "messages it came from stay in the conversation record (history_search) — tell Sid that if he " +
    "may expect the conversation itself to be gone.",
  async (ctx, id) => {
    await ctx.facts.forget(id);
    const err = await unindexFact(ctx, id);
    return {
      ok: true,
      status: "ok",
      message: err
        ? `Hid fact ${id}. (Removing it from the meaning index failed: ${err}; search still hides it because it is hidden.)`
        : `Hid fact ${id}`,
    };
  },
);

export const memoryRestore = simpleFactTool(
  "memory_restore",
  "Un-hide a previously forgotten fact.",
  async (ctx, id) => {
    const f = await ctx.facts.restore(id);
    const indexError = await indexFact(ctx, f);
    return withIndexNote({ ok: true, status: "ok", message: `Restored fact ${id}` }, indexError);
  },
);

export const memoryConfirm = simpleFactTool(
  "memory_confirm",
  "Mark an inferred fact as confirmed, once Sid has confirmed it.",
  async (ctx, id) => {
    await ctx.facts.confirm(id);
    return { ok: true, status: "ok", message: `Confirmed fact ${id}` };
  },
);

export const memoryPin = simpleFactTool(
  "memory_pin",
  "Add a fact to the core profile (pinned facts are injected into your context every turn). " +
    "Pin only the handful of facts that define who Sid is.",
  async (ctx, id) => {
    await ctx.facts.pin(id);
    return { ok: true, status: "ok", message: `Pinned fact ${id}` };
  },
);

export const memoryUnpin = simpleFactTool(
  "memory_unpin",
  "Remove a fact from the core profile.",
  async (ctx, id) => {
    await ctx.facts.unpin(id);
    return { ok: true, status: "ok", message: `Unpinned fact ${id}` };
  },
);

function factStatus(f: Fact, ctx: ToolContext): string {
  if (f.supersededBy) return `superseded by ${f.supersededBy}`;
  if (f.hidden) return "hidden (forgotten)";
  if (!ctx.facts.isActive(f)) return "expired";
  return "active";
}

export const memoryExplain: Tool = {
  name: "memory_explain",
  description:
    "Show every version of a fact, oldest first: its text, confidence, when and why it changed, " +
    "its status (active, hidden, expired, superseded) and the exact message each version rests on " +
    "(quoted from the record, with date and channel). Use it when Sid asks 'why do you think that?' " +
    "or 'what did it say before?'.",
  parameters: { type: "object", properties: { fact_id: { type: "string" } }, required: ["fact_id"] },
  async run(args, ctx): Promise<ToolResult> {
    const id = String(args.fact_id);
    if (!(await ctx.facts.get(id))) return refused(`fact ${id} does not exist.`);
    const chain = await ctx.facts.explain(id);
    const versions = [];
    for (const f of chain) {
      const msg = f.sourceMessageId ? await ctx.conversation.get(f.sourceMessageId) : undefined;
      versions.push({
        id: f.id,
        text: f.text,
        kind: f.kind,
        confidence: f.confidence,
        createdAt: f.createdAt,
        expiresAt: f.expiresAt,
        status: factStatus(f, ctx),
        pinned: f.pinned,
        correctionReason: f.correctionReason,
        sourceType: f.sourceType,
        sourceRef: f.sourceRef,
        sourceMessage: f.sourceMessageId
          ? msg
            ? { id: msg.id, role: msg.role, channel: msg.channel, at: msg.createdAt, content: msg.content, forwarded: msg.forwarded === true }
            : { id: f.sourceMessageId, missing: true }
          : null,
      });
    }
    return { ok: true, status: "ok", data: { versions } };
  },
};

/**
 * Paging arguments shared by the search/list tools. Sid's rule (2026-09-26):
 * "Jarvis should get as much as he needs to do what he wants." So `limit` is
 * optional and omitting it means EVERY match — there is no hidden count cap.
 * `offset` pages through big answers. Returns null + reason on a bad value.
 */
function paging(args: Record<string, unknown>): { limit?: number; offset: number } | { error: string } {
  const out: { limit?: number; offset: number } = { offset: 0 };
  if (args.limit !== undefined && args.limit !== null) {
    const l = modelLimit(args.limit);
    if (l === null) return { error: `limit must be a whole number of at least 1 (or leave it out for everything): ${JSON.stringify(args.limit)}` };
    out.limit = l;
  }
  if (args.offset !== undefined && args.offset !== null) {
    if (typeof args.offset !== "number" || !Number.isFinite(args.offset) || args.offset < 0) {
      return { error: `offset must be a whole number of at least 0: ${JSON.stringify(args.offset)}` };
    }
    out.offset = Math.floor(args.offset);
  }
  return out;
}

const PAGING_PROPS = {
  limit: { type: "number", description: "Optional: how many you want. Leave it out to get every match." },
  offset: { type: "number", description: "Optional: skip this many first (to page through a big answer)." },
};

export const memorySearch: Tool = {
  name: "memory_search",
  description:
    "Meaning search over everything you remember about Sid. Returns facts related to your query, " +
    "best match first, even when the words differ. Hidden, expired and outdated facts are never " +
    "returned. limit/offset are optional — leave limit out to get every match the meaning index can " +
    "rank. The result reports indexCeiling if the index itself can rank no more (use memory_list to " +
    "read everything), and how many active facts are not yet indexed, so an empty answer is never " +
    "mistaken for 'nothing remembered'.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, ...PAGING_PROPS },
    required: ["query"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (query.trim() === "") return refused("query is required.");
    const pg = paging(args);
    if ("error" in pg) return refused(pg.error);
    const ceiling = ctx.vectors.maxTopK;
    let hits;
    try {
      const vec = await ctx.embeddings.embed(query);
      // Ask for as many as the index can rank; inactive facts are dropped after.
      hits = await ctx.vectors.query(vec, ceiling ?? Number.MAX_SAFE_INTEGER);
    } catch (e) {
      return { ok: false, status: "error", message: `Meaning search is unavailable: ${(e as Error).message}. Try memory_list or history_search.` };
    }
    const active: unknown[] = [];
    let droppedInactive = 0;
    for (const h of hits) {
      const f = await ctx.facts.get(h.id);
      if (!f || !ctx.facts.isActive(f)) {
        droppedInactive += 1;
        continue;
      }
      active.push({ id: f.id, text: f.text, kind: f.kind, confidence: f.confidence, createdAt: f.createdAt, pinned: f.pinned, score: h.score });
    }
    const page = active.slice(pg.offset, pg.limit === undefined ? undefined : pg.offset + pg.limit);
    const nextOffset = pg.offset + page.length < active.length ? pg.offset + page.length : null;
    const { total: notYetIndexed } = await ctx.facts.unindexedActive(0);
    return {
      ok: true,
      status: "ok",
      data: {
        results: page,
        totalMatches: active.length,
        nextOffset,
        droppedInactive,
        notYetIndexed,
        ...(ceiling !== undefined && hits.length >= ceiling ? { indexCeiling: ceiling } : {}),
      },
    };
  },
};

export const memoryList: Tool = {
  name: "memory_list",
  description:
    "Read what you remember directly, no search query: every active fact, oldest first. Optional " +
    "filters: kind ('durable' or 'temporary'), pinned (true/false). include_inactive: true also " +
    "returns hidden (forgotten), expired and outdated (corrected) versions, each labelled with its " +
    "status. limit/offset are optional — leave limit out to get everything.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["durable", "temporary"] },
      pinned: { type: "boolean" },
      include_inactive: { type: "boolean" },
      ...PAGING_PROPS,
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    const pg = paging(args);
    if ("error" in pg) return refused(pg.error);
    if (args.kind !== undefined && args.kind !== "durable" && args.kind !== "temporary") {
      return refused(`kind must be durable or temporary: ${JSON.stringify(args.kind)}`);
    }
    if (args.pinned !== undefined && typeof args.pinned !== "boolean") return refused("pinned must be true or false.");
    if (args.include_inactive !== undefined && typeof args.include_inactive !== "boolean") {
      return refused("include_inactive must be true or false.");
    }
    const source = args.include_inactive === true ? await ctx.facts.all() : await ctx.facts.activeFacts();
    const matches = source.filter(
      (f) => (args.kind === undefined || f.kind === args.kind) && (args.pinned === undefined || f.pinned === args.pinned),
    );
    const page = matches.slice(pg.offset, pg.limit === undefined ? undefined : pg.offset + pg.limit);
    return {
      ok: true,
      status: "ok",
      data: {
        results: page.map((f) => ({
          id: f.id,
          text: f.text,
          kind: f.kind,
          confidence: f.confidence,
          pinned: f.pinned,
          createdAt: f.createdAt,
          expiresAt: f.expiresAt,
          status: factStatus(f, ctx),
        })),
        total: matches.length,
        nextOffset: pg.offset + page.length < matches.length ? pg.offset + page.length : null,
      },
    };
  },
};

export const historySearch: Tool = {
  name: "history_search",
  description:
    "Literal search of the full conversation record — every text and every call transcript, " +
    "Sid's words and yours — including messages older summaries replaced in your context. Use it " +
    "for exact wording ('what did I say about the dentist?') or to find a message id to cite. " +
    "query: text to find (case-insensitive). since/until: optional RFC3339 bounds. channel: " +
    "optional 'text' or 'voice' (voice = phone calls). Newest first. limit/offset are optional — " +
    "leave limit out to get every match. Results carry ids (msg_...) usable as source_message_id. " +
    "The result reports totalMatches, nextOffset and coverage (how many messages are stored and " +
    "since when), so 'no match' can be told apart from 'not stored'.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      since: { type: "string", description: "Optional RFC3339 lower bound (inclusive)." },
      until: { type: "string", description: "Optional RFC3339 upper bound (inclusive)." },
      channel: { type: "string", enum: CHANNELS, description: "Optional: text or voice." },
      ...PAGING_PROPS,
    },
    required: ["query"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (query.trim() === "") return refused("query is required.");
    const pg = paging(args);
    if ("error" in pg) return refused(pg.error);
    const q: import("../conversation/conversation-repo.js").HistoryQuery = { query, offset: pg.offset };
    if (pg.limit !== undefined) q.limit = pg.limit;
    if (args.since !== undefined) {
      const since = realInstant(args.since);
      if (!since) return refused(`since is not a real date: ${JSON.stringify(args.since)}`);
      q.since = since;
    }
    if (args.until !== undefined) {
      const until = realInstant(args.until);
      if (!until) return refused(`until is not a real date: ${JSON.stringify(args.until)}`);
      q.until = until;
    }
    if (q.since && q.until && q.since > q.until) return refused("since is after until.");
    if (args.channel !== undefined) {
      if (!CHANNELS.includes(args.channel as Channel)) return badEnum("channel", args.channel, CHANNELS);
      q.channel = args.channel as Channel;
    }
    const r = await ctx.conversation.search(q);
    const shown = pg.offset + r.results.length;
    return {
      ok: true,
      status: "ok",
      data: {
        results: r.results.map((m) => ({
          id: m.id,
          role: m.role === "user" ? "sid" : "jarvis",
          content: m.content,
          at: m.createdAt,
          channel: m.channel,
          ...(m.forwarded ? { forwarded: true } : {}),
        })),
        totalMatches: r.totalMatches,
        nextOffset: shown < r.totalMatches ? shown : null,
        coverage: { storedMessages: r.storedMessages, earliestStored: r.earliestStored },
      },
    };
  },
};

export const memoryTools: Tool[] = [
  memorySave,
  memoryCorrect,
  memoryForget,
  memoryRestore,
  memoryConfirm,
  memoryPin,
  memoryUnpin,
  memoryExplain,
  memorySearch,
  memoryList,
  historySearch,
];
