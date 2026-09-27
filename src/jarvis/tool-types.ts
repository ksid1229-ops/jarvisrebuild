import type { Clock } from "../clock.js";
import type { ConversationStore } from "../conversation/conversation-repo.js";
import type { EmbeddingProvider, VectorIndex } from "../memory/embeddings.js";
import type { FactsStore } from "../memory/facts-repo.js";
import type { PendingStore } from "../confirmations/pending-actions.js";
import type { ReceiptsStore } from "../receipts/receipts-repo.js";
import type { SettingsStore } from "../settings/settings-repo.js";
import type { ToolSchema } from "../model/types.js";
import type { Provenance, Trigger } from "../types.js";

export interface ToolResult {
  ok: boolean;
  /** Machine status: ok | not_connected | refused | shadow | error | confirmation_requested | ... */
  status: string;
  /** Human-facing detail returned to the model. */
  message?: string;
  data?: unknown;
}

/** A channel that can actually deliver a message to Sid. */
export interface OwnerChannel {
  /** Returns a status; never fabricates success. */
  sendText(message: string): Promise<{ ok: boolean; status: string; detail?: string }>;
}

export interface ToolContext {
  clock: Clock;
  ownerId: string;
  /** Provenance of the CURRENT turn, set by code from the channel. */
  provenance: Provenance;
  /** What triggered this turn. Recorded on every receipt. */
  trigger: Trigger;
  /** A unique id for the current event/turn. Confirmations may not self-confirm within it. */
  eventId: string;
  /** The current owner message text, for provenance quote verification. */
  ownerMessageText: string;
  /** messages.id of the current message once stored (live owner turns only). */
  currentMessageId?: string;

  facts: FactsStore;
  conversation: ConversationStore;
  receipts: ReceiptsStore;
  pending: PendingStore;
  settings: SettingsStore;
  embeddings: EmbeddingProvider;
  vectors: VectorIndex;
  ownerChannel: OwnerChannel;

  /** Enqueue a wake-up (Phase 6). Returns a status; a no-op scheduler is honest about it. */
  scheduleWakeup?: (fireAtIso: string, reason: string) => Promise<{ ok: boolean; status: string; id?: string }>;

  /** Connected-apps manager (Phase 3). Present once app support is wired. */
  apps?: import("../apps/app-manager.js").AppManager;

  // ---- Voice (Phase 5) ----
  /** Present on a call. Holds caller role + this-call PIN state. */
  call?: import("../voice/call-session.js").CallSession;
  /** Verifies the owner's 4-digit PIN (hash compare). Fail-closed when unconfigured. */
  ownerPinVerifier?: import("../voice/pin.js").OwnerPinVerifier;
  /** Guest registry, for guest_create / guest_revoke. */
  guests?: import("../voice/guests-repo.js").GuestsStore;
  /** Pepper for hashing guest PINs at rest. */
  pinPepper?: string;

  // ---- Daily rhythm + plumbing (Phases 6-7) ----
  /** Wake-up scheduler (schedule/list/cancel). */
  wakeups?: import("../scheduler/wakeup-scheduler.js").WakeupScheduler;
  /** Conversation archive search. */
  archive?: import("../plumbing/archive.js").ArchiveService;

  // ---- School (D1-backed evidence + collector keys + request queue) ----
  /** Present when a database is wired. Absent => school tools fail closed. */
  school?: import("../school/school-tools.js").SchoolServices;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema;
  /** True for exactly the five confirmed actions (brief section 3). */
  confirmable?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
