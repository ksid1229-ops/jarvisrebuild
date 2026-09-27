import type { Clock } from "../clock.js";
import type { ConversationStore } from "../conversation/conversation-repo.js";
import type { PendingStore } from "../confirmations/pending-actions.js";
import type { EmbeddingProvider, VectorIndex } from "../memory/embeddings.js";
import type { FactsStore } from "../memory/facts-repo.js";
import type { ReceiptsStore } from "../receipts/receipts-repo.js";
import type { SettingsStore } from "../settings/settings-repo.js";
import type { ChatMessage, Model } from "../model/types.js";
import type { Channel, Provenance, Trigger } from "../types.js";
import { ToolDispatcher } from "../confirmations/gate.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildGuestPinPrompt, buildGuestPrompt } from "../voice/guest-prompt.js";
import { buildExternalCallPrompt, END_CALL_TOOL } from "../voice/external-prompt.js";
import { guestStillActive, verifyGuestPinOnCall } from "../voice/call-auth.js";
import type { ToolDefinition } from "../model/types.js";
import type { CallSession } from "../voice/call-session.js";
import type { OwnerPinVerifier } from "../voice/pin.js";
import type { GuestsStore } from "../voice/guests-repo.js";
import type { OwnerChannel, ToolContext } from "./tool-types.js";

/** A runaway cap on tool-calling rounds (system protection, not "one action per turn"). */
export const MAX_TOOL_ROUNDS = 8;

/** Rounds on a guest turn: at most a PIN check and a spoken answer, with slack. */
const MAX_GUEST_ROUNDS = 3;

/** The only tool a guest-number caller ever sees, and only before their PIN is proven. */
export const GUEST_PIN_TOOL: ToolDefinition = {
  name: "guest_pin_verify",
  description:
    "Check the caller's 4-digit guest PIN. Call it with exactly the four digits the caller said. " +
    "Only after it succeeds may you use the guest's granted access.",
  parameters: { type: "object", properties: { pin: { type: "string" } }, required: ["pin"] },
};

export interface JarvisEvent {
  channel: Channel;
  trigger: Trigger;
  provenance: Provenance;
  /** Incoming text: Sid's message, a call utterance, or a wake-up instruction. */
  text: string;
  eventId: string;
  /** Present on a call. Carries caller role + this-call PIN state. */
  call?: CallSession;
}

export interface AgentResult {
  reply: string;
  iterations: number;
  error?: string;
  /** Every tool call this turn with its outcome (proof for callers such as memory reviews). */
  toolCalls: { name: string; ok: boolean; status: string }[];
  /** True when the turn hit MAX_TOOL_ROUNDS without a final reply. */
  capped?: boolean;
}

export interface HandleOptions {
  /** Run this turn on a different model (MEMORY_EXTRACTION_MODEL for reviews). Same tools, same memory. */
  model?: Model;
}

export interface AgentDeps {
  model: Model;
  dispatcher: ToolDispatcher;
  facts: FactsStore;
  conversation: ConversationStore;
  receipts: ReceiptsStore;
  pending: PendingStore;
  settings: SettingsStore;
  embeddings: EmbeddingProvider;
  vectors: VectorIndex;
  clock: Clock;
  ownerChannel: OwnerChannel;
  timezone: string;
  ownerId: string;
  apps?: import("../apps/app-manager.js").AppManager;
  ownerPinVerifier?: OwnerPinVerifier;
  guests?: GuestsStore;
  pinPepper?: string;
  wakeups?: import("../scheduler/wakeup-scheduler.js").WakeupScheduler;
  archive?: import("../plumbing/archive.js").ArchiveService;
  school?: import("../school/school-tools.js").SchoolServices;
  phone?: import("../channels/phone.js").PhoneServices;
  email?: import("../email/email-tools.js").EmailServices;
  pc?: import("../pc/pc-tools.js").PcServices;
  /** Called after each live owner exchange (text or call) — arms the quiet-conversation review. */
  afterOwnerTurn?: () => Promise<void>;
  /** Which text channels are set up and which Sid used last (shown in the prompt). */
  textChannels?: () => Promise<{ available: import("../types.js").TextMedium[]; lastUsed?: import("../types.js").TextMedium }>;
}

/**
 * The ONE brain. Text and voice both call handle(). Same model, tools, memory,
 * state and permissions — the only difference between channels is phrasing,
 * carried in the system prompt.
 */
export class AgentCore {
  constructor(private readonly d: AgentDeps) {}

  private makeContext(event: JarvisEvent, currentMessageId?: string): ToolContext {
    return {
      ...(currentMessageId ? { currentMessageId } : {}),
      clock: this.d.clock,
      ownerId: this.d.ownerId,
      provenance: event.provenance,
      trigger: event.trigger,
      eventId: event.eventId,
      ownerMessageText: event.text,
      facts: this.d.facts,
      conversation: this.d.conversation,
      receipts: this.d.receipts,
      pending: this.d.pending,
      settings: this.d.settings,
      embeddings: this.d.embeddings,
      vectors: this.d.vectors,
      ownerChannel: this.d.ownerChannel,
      apps: this.d.apps,
      call: event.call,
      ownerPinVerifier: this.d.ownerPinVerifier,
      guests: this.d.guests,
      pinPepper: this.d.pinPepper,
      wakeups: this.d.wakeups,
      archive: this.d.archive,
      school: this.d.school,
      phone: this.d.phone,
      email: this.d.email,
      pc: this.d.pc,
    };
  }

  async handle(event: JarvisEvent, opts: HandleOptions = {}): Promise<AgentResult> {
    // A third party on a call JARVIS placed (make_call): a separate minimal
    // brain carrying only the confirmed brief. See handleExternal.
    if (event.call && event.call.role === "external") {
      return this.handleExternal(event, event.call);
    }
    // A guest (or unknown) caller gets a completely separate, minimal brain:
    // no owner profile, no owner memory, no tools. See handleGuest.
    if (event.call && event.call.role !== "owner") {
      return this.handleGuest(event, event.call);
    }
    const model = opts.model ?? this.d.model;

    // Persist Sid's own words (text/call). Wake-ups are not Sid's words. The
    // stored message keeps its provenance (forwarded, channel ref) so a stated
    // fact can later be tied to exactly this message.
    const interactive = event.trigger === "text" || event.trigger === "call";
    let currentMessageId: string | undefined;
    if (interactive) {
      const m = await this.d.conversation.append("user", event.text, event.channel, {
        forwarded: event.provenance.isForwarded,
        sourceRef: event.provenance.sourceRef,
      });
      currentMessageId = m.id;
      await this.archive(m, event);
    }
    const ctx = this.makeContext(event, currentMessageId);
    const toolCalls: AgentResult["toolCalls"] = [];

    const recent = await this.d.conversation.recent();
    const messages: ChatMessage[] = [
      { role: "system", content: await this.currentSystemPrompt(event.channel, event.provenance.medium) },
      ...recent.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    ];
    if (!interactive) {
      // Wake-ups arrive as an instruction the model acts on.
      messages.push({ role: "user", content: `[${event.trigger}] ${event.text}` });
    }

    const tools = this.d.dispatcher.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    let reply = "";
    let rounds = 0;
    for (; rounds < MAX_TOOL_ROUNDS; rounds++) {
      let resp;
      try {
        resp = await model.complete({ messages, tools });
      } catch (e) {
        const msg = (e as Error).message;
        await this.d.receipts.log({
          tool: "model",
          input: { round: rounds },
          result: { error: msg },
          trigger: event.trigger,
          performed: false,
          status: "error",
        });
        return { reply: "", iterations: rounds, error: msg, toolCalls };
      }

      if (resp.toolCalls.length === 0) {
        reply = resp.content;
        break;
      }

      messages.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });
      for (const call of resp.toolCalls) {
        let args: Record<string, unknown> = {};
        let parseError: string | undefined;
        try {
          args = call.argumentsJson ? (JSON.parse(call.argumentsJson) as Record<string, unknown>) : {};
        } catch (e) {
          parseError = `could not parse arguments: ${(e as Error).message}`;
        }
        const result = parseError
          ? { ok: false, status: "error", message: parseError }
          : await this.d.dispatcher.dispatch(call.name, args, ctx);
        toolCalls.push({ name: call.name, ok: result.ok === true, status: String(result.status) });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    const capped = rounds >= MAX_TOOL_ROUNDS && reply === "";
    if (capped) {
      await this.d.receipts.log({
        tool: "agent_loop",
        input: { eventId: event.eventId },
        result: { note: "hit MAX_TOOL_ROUNDS without a final reply" },
        trigger: event.trigger,
        performed: false,
        status: "runaway_capped",
      });
    }

    if (interactive) {
      if (reply.trim() === "") {
        // No silent drops: surface an empty reply.
        await this.d.receipts.log({
          tool: "agent_reply",
          input: { eventId: event.eventId },
          result: { note: "model produced an empty reply on an interactive turn" },
          trigger: event.trigger,
          performed: false,
          status: "empty_reply",
        });
      } else {
        const m = await this.d.conversation.append("assistant", reply, event.channel);
        await this.archive(m, event);
      }
      if (this.d.afterOwnerTurn) {
        try {
          await this.d.afterOwnerTurn();
        } catch (e) {
          await this.d.receipts.log({
            tool: "memory_review_timer",
            input: { eventId: event.eventId },
            result: { error: (e as Error).message },
            trigger: event.trigger,
            performed: false,
            status: "error",
          });
        }
      }
    }

    await this.summarizeIfNeeded(event.channel);

    return { reply, iterations: rounds, toolCalls, ...(capped ? { capped: true } : {}) };
  }

  /** Copy a stored message to the dated R2 archive. A failure is a receipt, never silent. */
  private async archive(m: import("../types.js").StoredMessage, event: JarvisEvent): Promise<void> {
    if (!this.d.archive) return;
    try {
      await this.d.archive.append({ id: m.id, at: m.createdAt, role: m.role, content: m.content, channel: m.channel });
    } catch (e) {
      await this.d.receipts.log({
        tool: "archive_append",
        input: { messageId: m.id },
        result: { error: (e as Error).message },
        trigger: event.trigger,
        performed: false,
        status: "error",
      });
    }
  }

  /**
   * Guest / unknown caller handling. A guest gets NONE of Sid's profile, memory
   * or tools — only a minimal prompt built from their granted access. Their
   * transcript lives on the call session, never in Sid's memory. This is the
   * fix for the first build's leak of pinned facts into guest prompts.
   */
  private async handleGuest(event: JarvisEvent, call: CallSession): Promise<AgentResult> {
    // A matched guest who has not proved themselves gets the PIN prompt and ONE
    // tool (guest_pin_verify). A verified guest is re-checked every turn so a
    // revoke or expiry mid-call takes effect on the next utterance.
    let revoked = false;
    if (call.role === "guest" && call.guestVerified) {
      revoked = !(await guestStillActive(call, this.d.guests, this.d.clock));
    }
    call.guestHistory.push({ role: "user", content: event.text });

    const toolCalls: AgentResult["toolCalls"] = [];
    let rounds = 0;
    let reply = "";
    while (rounds < MAX_GUEST_ROUNDS) {
      rounds++;
      const pinPhase = call.role === "guest" && !!call.guestId && !call.guestVerified;
      const system = pinPhase
        ? buildGuestPinPrompt({ nowIso: this.d.clock.nowIso(), timezone: this.d.timezone, revoked })
        : buildGuestPrompt({ access: call.access, nowIso: this.d.clock.nowIso(), timezone: this.d.timezone });
      const messages: ChatMessage[] = [{ role: "system", content: system }, ...call.guestHistory];
      let resp;
      try {
        // Guests get NO tools, except guest_pin_verify while their PIN is unproven.
        resp = await this.d.model.complete({ messages, tools: pinPhase ? [GUEST_PIN_TOOL] : [] });
      } catch (e) {
        const msg = (e as Error).message;
        await this.d.receipts.log({
          tool: "model",
          input: { guestCall: call.callId },
          result: { error: msg },
          trigger: event.trigger,
          performed: false,
          status: "error",
        });
        return { reply: "", iterations: rounds, error: msg, toolCalls };
      }
      if (resp.toolCalls.length === 0) {
        reply = resp.content;
        break;
      }
      call.guestHistory.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });
      for (const tc of resp.toolCalls) {
        let result: import("./tool-types.js").ToolResult;
        if (tc.name !== GUEST_PIN_TOOL.name || !pinPhase) {
          result = { ok: false, status: "refused", message: `No tool named ${tc.name} is available on this call.` };
        } else {
          let pin = "";
          try {
            pin = String((JSON.parse(tc.argumentsJson || "{}") as { pin?: unknown }).pin ?? "");
          } catch {
            pin = "";
          }
          result = await verifyGuestPinOnCall(call, pin, {
            guests: this.d.guests,
            pepper: this.d.pinPepper,
            clock: this.d.clock,
          });
          // Receipt of the attempt — never the digits.
          await this.d.receipts.log({
            tool: GUEST_PIN_TOOL.name,
            input: { guestCall: call.callId, guestId: call.guestId, via: "spoken" },
            result: { ok: result.ok, status: result.status },
            trigger: event.trigger,
            performed: result.ok === true,
            status: String(result.status),
          });
        }
        toolCalls.push({ name: tc.name, ok: result.ok === true, status: String(result.status) });
        call.guestHistory.push({ role: "tool", content: JSON.stringify(result), toolCallId: tc.id, name: tc.name });
      }
    }
    if (reply.trim() !== "") call.guestHistory.push({ role: "assistant", content: reply });
    return { reply, iterations: rounds, toolCalls };
  }

  /**
   * A two-way call Jarvis placed on Sid's behalf (make_call, confirmed). The
   * third party gets a minimal brain: the confirmed brief and NOTHING else —
   * no owner profile, no pinned facts, no memory, no tools except end_call.
   * Their words stay on the session transcript (kept as a receipt by the relay
   * when the call ends); they are NEVER stored as if they were conversation
   * with Sid, so memory extraction cannot mistake them for Sid's words.
   */
  private async handleExternal(event: JarvisEvent, call: CallSession): Promise<AgentResult> {
    const brief = call.externalBrief ?? "";
    const to = call.externalTo ?? call.callerId;
    const system = buildExternalCallPrompt({
      to,
      brief: brief === "" ? "(the brief was not found — say you will call back, do not improvise)" : brief,
      nowIso: this.d.clock.nowIso(),
      timezone: this.d.timezone,
    });
    call.externalHistory.push({ role: "user", content: event.text });

    const toolCalls: AgentResult["toolCalls"] = [];
    let rounds = 0;
    let reply = "";
    while (rounds < MAX_GUEST_ROUNDS) {
      rounds++;
      const messages: ChatMessage[] = [{ role: "system", content: system }, ...call.externalHistory];
      let resp;
      try {
        resp = await this.d.model.complete({ messages, tools: [END_CALL_TOOL] });
      } catch (e) {
        const msg = (e as Error).message;
        await this.d.receipts.log({
          tool: "model",
          input: { externalCall: call.callId, to },
          result: { error: msg },
          trigger: event.trigger,
          performed: false,
          status: "error",
        });
        return { reply: "", iterations: rounds, error: msg, toolCalls };
      }
      if (resp.toolCalls.length === 0) {
        reply = resp.content;
        break;
      }
      call.externalHistory.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });
      for (const tc of resp.toolCalls) {
        let result: import("./tool-types.js").ToolResult;
        if (tc.name !== END_CALL_TOOL.name) {
          result = { ok: false, status: "refused", message: `No tool named ${tc.name} is available on this call.` };
        } else {
          result = { ok: true, status: "ok", message: "Ending the call." };
        }
        toolCalls.push({ name: tc.name, ok: result.ok, status: String(result.status) });
        call.externalHistory.push({ role: "tool", content: JSON.stringify(result), toolCallId: tc.id, name: tc.name });
      }
      if (toolCalls.some((t) => t.name === END_CALL_TOOL.name && t.ok)) {
        call.endRequested = true;
        break; // hang up without another model round
      }
    }
    if (reply.trim() !== "") call.externalHistory.push({ role: "assistant", content: reply });
    return { reply, iterations: rounds, toolCalls };
  }

  private async currentSystemPrompt(channel: Channel, medium?: import("../types.js").TextMedium): Promise<string> {
    const textChannels = this.d.textChannels ? await this.d.textChannels() : undefined;
    return buildSystemPrompt({
      ...(medium ? { medium } : {}),
      ...(textChannels ? { textChannels } : {}),
      nowIso: this.d.clock.nowIso(),
      timezone: this.d.timezone,
      channel,
      shadow: await this.d.settings.isShadow(),
      pinnedFacts: await this.d.facts.pinnedFacts(),
      personaOverride: await this.d.settings.get("persona"),
    });
  }

  /** Code triggers the summary (size cap); the MODEL writes it. */
  private async summarizeIfNeeded(channel: Channel): Promise<void> {
    if (!(await this.d.conversation.needsSummary())) return;
    const all = await this.d.conversation.context();
    const keep = 15;
    const toSummarizeCount = Math.max(0, all.length - keep);
    if (toSummarizeCount <= 0) return;
    const older = all.slice(0, toSummarizeCount);
    const transcript = older.map((m) => `${m.role}: ${m.content}`).join("\n");
    try {
      const resp = await this.d.model.complete({
        messages: [
          {
            role: "system",
            content:
              "Summarize the following conversation faithfully and concisely for long-term context. " +
              "Preserve facts, decisions, and open questions. Do not invent anything.",
          },
          { role: "user", content: transcript },
        ],
        tools: [],
      });
      const summary = resp.content.trim();
      if (summary !== "") {
        // Rolled-up messages stay in the record; the summary only replaces them in context.
        await this.d.conversation.applySummary(summary, toSummarizeCount);
      } else {
        await this.d.receipts.log({
          tool: "summarize",
          input: { channel, count: toSummarizeCount },
          result: { note: "model returned an empty summary; context left as is and retried next turn" },
          trigger: "wakeup",
          performed: false,
          status: "empty_reply",
        });
      }
    } catch (e) {
      await this.d.receipts.log({
        tool: "summarize",
        input: { channel, count: toSummarizeCount },
        result: { error: (e as Error).message },
        trigger: "wakeup",
        performed: false,
        status: "error",
      });
    }
  }
}
