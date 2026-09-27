/** Shared domain types. */

export type Channel = "text" | "voice";

/** What triggered a turn. Recorded on every receipt (Phase 1 tool logger). */
export type Trigger = "text" | "call" | "email" | "wakeup" | "app_event";

/**
 * Provenance: the facts the model cannot see for itself (brief: "Senses").
 * Set by CODE from the channel, never by the model.
 */
export interface Provenance {
  channel: Channel;
  /** True only when this text is Sid's own words in his own private chat/call. */
  isOwner: boolean;
  /** True when the message was forwarded from elsewhere (not Sid's own words). */
  isForwarded: boolean;
  /** True when this is a private 1:1 chat (not a group). */
  isPrivate: boolean;
  /** Opaque id of the source message/turn, for source_ref. */
  sourceRef: string;
  /** For sourceType "app": the connected app's name (audit round 3: so the prompt can say it). */
  sourceName?: string;
  /** conversation | call | email | app */
  sourceType: "conversation" | "call" | "email" | "app";
  /** Which of Sid's text channels this arrived on (text turns only). Replies go back on it. */
  medium?: TextMedium;
}

/** Sid's two text channels (2026-09-26: "both, one brain"). */
export type TextMedium = "telegram" | "sms";

// ---- Memory ----

export type FactKind = "durable" | "temporary";
/** Confidence is supplied by the model and REQUIRED. Never defaulted. */
export type FactConfidence = "stated" | "inferred" | "confirmed";

export interface Fact {
  id: string;
  text: string;
  kind: FactKind;
  confidence: FactConfidence;
  sourceType: Provenance["sourceType"];
  sourceRef: string;
  createdAt: string; // RFC3339 UTC
  expiresAt: string | null; // required decision from model for temporary facts
  supersededBy: string | null;
  hidden: boolean;
  pinned: boolean;
  /** The stored message (messages.id) this version rests on, when there is one. */
  sourceMessageId: string | null;
  /** Why this version replaced the previous one (memory_correct). Null on a first version. */
  correctionReason: string | null;
  /** True once the fact's embedding is in the meaning-search index. */
  indexed: boolean;
}

// ---- Conversation ----

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel: Channel;
  createdAt: string;
  /** True when this message is a rollup summary of older messages. */
  isSummary?: boolean;
  /** True when a summary has replaced this message in the model's context. The row is kept. */
  rolledUp?: boolean;
  /** True when Sid forwarded this text from elsewhere (not his own words). */
  forwarded?: boolean;
  /** The channel-level id (e.g. telegram:chat:msg) this message arrived as. */
  sourceRef?: string;
}

// ---- Receipts (Proof) ----

export interface Receipt {
  id: string;
  at: string;
  tool: string;
  inputJson: string;
  resultJson: string;
  trigger: Trigger;
  /** true = the tool actually performed; false = refused / not connected / shadow. */
  performed: boolean;
  status: string; // "ok" | "not_connected" | "refused" | "shadow" | "error" | ...
}

// ---- Confirmations (Proof: enforced taps) ----

export type PendingStatus = "pending" | "confirmed" | "cancelled" | "expired" | "executed";

export interface PendingAction {
  id: string;
  tool: string;
  argsJson: string;
  argsHash: string;
  summary: string;
  ownerId: string;
  creatingEventId: string;
  createdAt: string;
  expiresAt: string;
  status: PendingStatus;
}

// ---- Settings ----
export interface SettingRow {
  key: string;
  value: string;
}

// ---- Connected apps (Phase 3) ----
export interface ConnectedApp {
  id: string;
  name: string;
  baseUrl: string;
  authSecret: string;
  enabled: boolean;
  addedAt: string;
}

// ---- Wake-ups (Phase 6) ----
/** owner = a reminder the model set; memory_review = the conversation-went-quiet timer. */
export type WakeupKind = "owner" | "memory_review";

export interface Wakeup {
  id: string;
  fireAt: string;
  reason: string;
  createdAt: string;
  kind: WakeupKind;
}
