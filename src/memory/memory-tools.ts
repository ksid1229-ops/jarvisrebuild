import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";
import { verifyQuote } from "./provenance.js";
import type { FactConfidence, FactKind } from "../types.js";

const KINDS: FactKind[] = ["durable", "temporary"];
const CONFIDENCES: FactConfidence[] = ["stated", "inferred", "confirmed"];

function badEnum(field: string, value: unknown, allowed: string[]): ToolResult {
  return {
    ok: false,
    status: "refused",
    message: `${field} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}. Not defaulted.`,
  };
}

/** Index a fact for meaning search. */
async function indexFact(ctx: ToolContext, id: string, text: string): Promise<void> {
  const vector = await ctx.embeddings.embed(text);
  await ctx.vectors.upsert(id, vector);
}

export const memorySave: Tool = {
  name: "memory_save",
  description:
    "Save one thing worth remembering about Sid or his world. Call it whenever you notice " +
    "something durable or useful — you do NOT wait to be told to remember. " +
    "text: the fact in your own clear words. " +
    "kind: 'durable' for things that stay true (he has an iPhone 16), 'temporary' for things " +
    "that expire (he's away this weekend) — a temporary fact REQUIRES expires_at as an RFC3339 " +
    "UTC instant. " +
    "confidence: 'stated' if Sid said it (you MUST also pass quote: the exact words from his " +
    "message), 'inferred' if you concluded it, 'confirmed' only once Sid confirms an inference. " +
    "confidence is required and never defaulted. " +
    "Example: memory_save(text='Sid hates mornings', kind='durable', confidence='stated', " +
    "quote='i hate mornings').",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The fact, in your words." },
      kind: { type: "string", enum: KINDS, description: "durable or temporary" },
      confidence: { type: "string", enum: CONFIDENCES, description: "stated | inferred | confirmed" },
      quote: { type: "string", description: "Required when confidence='stated': Sid's exact words." },
      expires_at: { type: "string", description: "Required when kind='temporary': RFC3339 UTC instant." },
      pinned: { type: "boolean", description: "Set true only for core-profile facts." },
    },
    required: ["text", "kind", "confidence"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const text = args.text;
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, status: "refused", message: "text is required." };
    }
    const kind = args.kind as FactKind;
    if (!KINDS.includes(kind)) return badEnum("kind", args.kind, KINDS);
    const confidence = args.confidence as FactConfidence;
    if (!CONFIDENCES.includes(confidence)) return badEnum("confidence", args.confidence, CONFIDENCES);

    let expiresAt: string | null = null;
    if (kind === "temporary") {
      if (typeof args.expires_at !== "string") {
        return {
          ok: false,
          status: "refused",
          message: "A temporary fact requires expires_at (RFC3339 UTC). Refused rather than defaulted.",
        };
      }
      const t = Date.parse(args.expires_at);
      if (Number.isNaN(t)) {
        return { ok: false, status: "refused", message: `expires_at is not a real date: ${args.expires_at}` };
      }
      expiresAt = new Date(t).toISOString();
    }

    // Provenance: a 'stated' fact must quote Sid's words, verified against his message.
    if (confidence === "stated") {
      if (typeof args.quote !== "string") {
        return { ok: false, status: "refused", message: "A stated fact requires quote (Sid's exact words)." };
      }
      try {
        verifyQuote(args.quote, ctx.ownerMessageText);
      } catch (e) {
        return { ok: false, status: "refused", message: (e as Error).message };
      }
    }

    const fact = ctx.facts.save({
      text,
      kind,
      confidence,
      sourceType: ctx.provenance.sourceType,
      sourceRef: ctx.provenance.sourceRef,
      expiresAt,
      pinned: args.pinned === true,
    });
    await indexFact(ctx, fact.id, fact.text);
    return { ok: true, status: "ok", message: `Saved fact ${fact.id}`, data: { id: fact.id } };
  },
};

export const memoryCorrect: Tool = {
  name: "memory_correct",
  description:
    "Replace an existing fact with a corrected version, linking the new to the old (nothing is " +
    "overwritten; the history stays). Use when a new statement supersedes an old one. You state " +
    "the replacement's kind, confidence and (if temporary) expires_at — pass the same values if " +
    "only the wording changed. reason: why it changed.",
  parameters: {
    type: "object",
    properties: {
      fact_id: { type: "string" },
      new_text: { type: "string" },
      confidence: { type: "string", enum: CONFIDENCES },
      kind: { type: "string", enum: KINDS },
      expires_at: { type: "string", description: "Required when kind='temporary'." },
      reason: { type: "string" },
    },
    required: ["fact_id", "new_text", "confidence", "kind", "reason"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const fact = ctx.facts.get(String(args.fact_id));
    if (!fact) return { ok: false, status: "refused", message: `fact ${args.fact_id} does not exist.` };
    const kind = args.kind as FactKind;
    if (!KINDS.includes(kind)) return badEnum("kind", args.kind, KINDS);
    const confidence = args.confidence as FactConfidence;
    if (!CONFIDENCES.includes(confidence)) return badEnum("confidence", args.confidence, CONFIDENCES);
    let expiresAt: string | null = null;
    if (kind === "temporary") {
      if (typeof args.expires_at !== "string" || Number.isNaN(Date.parse(args.expires_at))) {
        return { ok: false, status: "refused", message: "A temporary correction requires a real expires_at." };
      }
      expiresAt = new Date(args.expires_at).toISOString();
    }
    const next = ctx.facts.correct(fact.id, String(args.new_text), confidence, kind, expiresAt);
    await ctx.vectors.remove(fact.id);
    await indexFact(ctx, next.id, next.text);
    return { ok: true, status: "ok", message: `Corrected into ${next.id}`, data: { id: next.id } };
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
      if (!ctx.facts.get(id)) return { ok: false, status: "refused", message: `fact ${id} does not exist.` };
      return op(ctx, id);
    },
  };
}

export const memoryForget = simpleFactTool(
  "memory_forget",
  "Hide a fact from recall (reversible with memory_restore). Use when Sid asks to forget something.",
  async (ctx, id) => {
    ctx.facts.forget(id);
    await ctx.vectors.remove(id);
    return { ok: true, status: "ok", message: `Hid fact ${id}` };
  },
);

export const memoryRestore = simpleFactTool(
  "memory_restore",
  "Un-hide a previously forgotten fact.",
  async (ctx, id) => {
    const f = ctx.facts.restore(id);
    const vec = await ctx.embeddings.embed(f.text);
    await ctx.vectors.upsert(id, vec);
    return { ok: true, status: "ok", message: `Restored fact ${id}` };
  },
);

export const memoryConfirm = simpleFactTool(
  "memory_confirm",
  "Mark an inferred fact as confirmed, once Sid has confirmed it.",
  (ctx, id) => {
    ctx.facts.confirm(id);
    return { ok: true, status: "ok", message: `Confirmed fact ${id}` };
  },
);

export const memoryPin = simpleFactTool(
  "memory_pin",
  "Add a fact to the core profile (pinned facts are injected into your context every turn). " +
    "Pin only the handful of facts that define who Sid is.",
  (ctx, id) => {
    ctx.facts.pin(id);
    return { ok: true, status: "ok", message: `Pinned fact ${id}` };
  },
);

export const memoryUnpin = simpleFactTool(
  "memory_unpin",
  "Remove a fact from the core profile.",
  (ctx, id) => {
    ctx.facts.unpin(id);
    return { ok: true, status: "ok", message: `Unpinned fact ${id}` };
  },
);

export const memoryExplain: Tool = {
  name: "memory_explain",
  description: "Show every version of a fact with its dated source, so you can see how it changed.",
  parameters: { type: "object", properties: { fact_id: { type: "string" } }, required: ["fact_id"] },
  async run(args, ctx): Promise<ToolResult> {
    const id = String(args.fact_id);
    if (!ctx.facts.get(id)) return { ok: false, status: "refused", message: `fact ${id} does not exist.` };
    const chain = ctx.facts.explain(id);
    return {
      ok: true,
      status: "ok",
      data: chain.map((f) => ({
        id: f.id,
        text: f.text,
        confidence: f.confidence,
        createdAt: f.createdAt,
        sourceType: f.sourceType,
        sourceRef: f.sourceRef,
        supersededBy: f.supersededBy,
      })),
    };
  },
};

export const memorySearch: Tool = {
  name: "memory_search",
  description:
    "Meaning search over everything you remember about Sid. Returns facts related to your query, " +
    "even when the words differ. Hidden and expired facts are never returned. Use it whenever a " +
    "reply would be better with what you know — you decide when and how many you need (pass limit).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "How many results you want. You choose." },
    },
    required: ["query"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (query.trim() === "") return { ok: false, status: "refused", message: "query is required." };
    // System-protection cap only; the model picks the real number via limit.
    const requested = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 10;
    const HARD_CAP = 50;
    const topK = Math.min(requested, HARD_CAP);
    const vec = await ctx.embeddings.embed(query);
    // Over-fetch, then drop hidden/expired, so filtering doesn't shrink below what the model asked.
    const hits = await ctx.vectors.query(vec, HARD_CAP);
    const results: unknown[] = [];
    let dropped = 0;
    for (const h of hits) {
      const f = ctx.facts.get(h.id);
      if (!f || !ctx.facts.isActive(f)) {
        dropped += 1;
        continue;
      }
      if (results.length < topK) {
        results.push({ id: f.id, text: f.text, confidence: f.confidence, score: h.score });
      }
    }
    return { ok: true, status: "ok", data: { results, droppedInactive: dropped } };
  },
};

export const historySearch: Tool = {
  name: "history_search",
  description:
    "Literal search of past conversations, including what YOU said on calls. Use it to find the " +
    "exact wording of something that was said. Returns matching messages with their dates.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  async run(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "");
    if (query.trim() === "") return { ok: false, status: "refused", message: "query is required." };
    const HARD_CAP = 50;
    const all = ctx.conversation.literalSearch(query);
    const results = all.slice(0, HARD_CAP);
    return {
      ok: true,
      status: "ok",
      data: {
        results: results.map((m) => ({ role: m.role, content: m.content, at: m.createdAt, channel: m.channel })),
        dropped: Math.max(0, all.length - results.length),
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
  historySearch,
];
