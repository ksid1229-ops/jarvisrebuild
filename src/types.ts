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
  /** conversation | call | email | app */
  sourceType: "conversation" | "call" | "email" | "app";
}

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
export interface Wakeup {
  id: string;
  fireAt: string;
  reason: string;
  createdAt: string;
}
