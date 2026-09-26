import type { Clock } from "../clock.js";
import type { ConversationRepo } from "../conversation/conversation-repo.js";
import type { PendingActionsRepo } from "../confirmations/pending-actions.js";
import type { EmbeddingProvider, VectorIndex } from "../memory/embeddings.js";
import type { FactsRepo } from "../memory/facts-repo.js";
import type { ReceiptsRepo } from "../receipts/receipts-repo.js";
import type { SettingsRepo } from "../settings/settings-repo.js";
import type { ChatMessage, Model } from "../model/types.js";
import type { Channel, Provenance, Trigger } from "../types.js";
import { ToolDispatcher } from "../confirmations/gate.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildGuestPrompt } from "../voice/guest-prompt.js";
import type { CallSession } from "../voice/call-session.js";
import type { OwnerPinVerifier } from "../voice/pin.js";
import type { GuestsRepo } from "../voice/guests-repo.js";
import type { OwnerChannel, ToolContext } from "./tool-types.js";

/** A runaway cap on tool-calling rounds (system protection, not "one action per turn"). */
export const MAX_TOOL_ROUNDS = 8;

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
}

export interface AgentDeps {
  model: Model;
  dispatcher: ToolDispatcher;
  facts: FactsRepo;
  conversation: ConversationRepo;
  receipts: ReceiptsRepo;
  pending: PendingActionsRepo;
  settings: SettingsRepo;
  embeddings: EmbeddingProvider;
  vectors: VectorIndex;
  clock: Clock;
  ownerChannel: OwnerChannel;
  timezone: string;
  ownerId: string;
  apps?: import("../apps/app-manager.js").AppManager;
  ownerPinVerifier?: OwnerPinVerifier;
  guests?: GuestsRepo;
  pinPepper?: string;
  wakeups?: import("../scheduler/wakeup-scheduler.js").WakeupScheduler;
  archive?: import("../plumbing/archive.js").ArchiveService;
}

/**
 * The ONE brain. Text and voice both call handle(). Same model, tools, memory,
 * state and permissions — the only difference between channels is phrasing,
 * carried in the system prompt.
 */
export class AgentCore {
  constructor(private readonly d: AgentDeps) {}

  private makeContext(event: JarvisEvent): ToolContext {
    return {
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
    };
  }

  async handle(event: JarvisEvent): Promise<AgentResult> {
    // A guest (or unknown) caller gets a completely separate, minimal brain:
    // no owner profile, no owner memory, no tools. See handleGuest.
    if (event.call && event.call.role !== "owner") {
      return this.handleGuest(event, event.call);
    }
    const ctx = this.makeContext(event);

    // Persist Sid's own words (text/call). Wake-ups are not Sid's words.
    const interactive = event.trigger === "text" || event.trigger === "call";
    if (interactive) {
      this.d.conversation.append("user", event.text, event.channel);
    }

    const messages: ChatMessage[] = [
      { role: "system", content: this.currentSystemPrompt(event.channel) },
      ...this.d.conversation
        .recent()
        .map((m): ChatMessage => ({ role: m.role, content: m.content })),
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
        resp = await this.d.model.complete({ messages, tools });
      } catch (e) {
        const msg = (e as Error).message;
        this.d.receipts.log({
          tool: "model",
          input: { round: rounds },
          result: { error: msg },
          trigger: event.trigger,
          performed: false,
          status: "error",
        });
        return { reply: "", iterations: rounds, error: msg };
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
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
          name: call.name,
        });
      }
    }

    if (rounds >= MAX_TOOL_ROUNDS && reply === "") {
      this.d.receipts.log({
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
        this.d.receipts.log({
          tool: "agent_reply",
          input: { eventId: event.eventId },
          result: { note: "model produced an empty reply on an interactive turn" },
          trigger: event.trigger,
          performed: false,
          status: "empty_reply",
        });
      } else {
        this.d.conversation.append("assistant", reply, event.channel);
      }
    }

    await this.summarizeIfNeeded(event.channel);

    return { reply, iterations: rounds };
  }

  /**
   * Guest / unknown caller handling. A guest gets NONE of Sid's profile, memory
   * or tools — only a minimal prompt built from their granted access. Their
   * transcript lives on the call session, never in Sid's memory. This is the
   * fix for the first build's leak of pinned facts into guest prompts.
   */
  private async handleGuest(event: JarvisEvent, call: CallSession): Promise<AgentResult> {
    const system = buildGuestPrompt({
      access: call.access,
      nowIso: this.d.clock.nowIso(),
      timezone: this.d.timezone,
    });
    call.guestHistory.push({ role: "user", content: event.text });
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...call.guestHistory,
    ];
    let resp;
    try {
      // Guests get NO tools.
      resp = await this.d.model.complete({ messages, tools: [] });
    } catch (e) {
      const msg = (e as Error).message;
      this.d.receipts.log({
        tool: "model",
        input: { guestCall: call.callId },
        result: { error: msg },
        trigger: event.trigger,
        performed: false,
        status: "error",
      });
      return { reply: "", iterations: 0, error: msg };
    }
    const reply = resp.content;
    if (reply.trim() !== "") call.guestHistory.push({ role: "assistant", content: reply });
    return { reply, iterations: 0 };
  }

  private currentSystemPrompt(channel: Channel): string {
    return buildSystemPrompt({
      nowIso: this.d.clock.nowIso(),
      timezone: this.d.timezone,
      channel,
      shadow: this.d.settings.isShadow(),
      pinnedFacts: this.d.facts.pinnedFacts(),
      personaOverride: this.d.settings.get("persona"),
    });
  }

  /** Code triggers the summary (size cap); the MODEL writes it. */
  private async summarizeIfNeeded(channel: Channel): Promise<void> {
    if (!this.d.conversation.needsSummary()) return;
    const all = this.d.conversation.all();
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
        this.d.conversation.applySummary(summary, toSummarizeCount);
      }
    } catch (e) {
      this.d.receipts.log({
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
