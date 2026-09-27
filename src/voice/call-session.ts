import type { ChatMessage } from "../model/types.js";
import { newId } from "../ids.js";

export type CallerRole = "owner" | "guest" | "unknown" | "external";

/**
 * Per-call state. Everything here is scoped to THIS call and is discarded when
 * the call ends — a PIN entered on an earlier call never authorizes a later one.
 * Guest history is kept here (never in the owner's memory) so a guest
 * conversation is coherent within the call without leaking into Sid's store.
 *
 * "external" is a third party Jarvis itself dialed (make_call, two-way): not
 * Sid, not a guest with access — a separate minimal prompt carrying only the
 * confirmed brief, and a transcript that is kept as a receipt, never stored as
 * if it were conversation with Sid.
 */
export interface CallSession {
  callId: string;
  callerId: string;
  role: CallerRole;
  /**
   * Guest access description (what they may hear/do). Empty for the owner, for
   * unknown callers, and for a guest until their guest PIN is verified — caller
   * ID alone can be spoofed, so it never unlocks a guest's access.
   */
  access: string;
  /** The guest record this caller ID matched. Access stays withheld until guestVerified. */
  guestId?: string;
  /** True once THIS call's guest entered their own 4-digit guest PIN. */
  guestVerified: boolean;
  /** Owner PIN verified on THIS call (required for the five confirmed actions). */
  pinVerified: boolean;
  /** Wrong PIN attempts on this call. At MAX_PIN_FAILURES_PER_CALL, PIN entry locks for the call. */
  pinFailures: number;
  /** Keypad digits collected so far (never stored anywhere else, never logged). */
  dtmfBuffer: string;
  /** Guest-only transcript, kept off the owner's memory. */
  guestHistory: ChatMessage[];
  /** External (make_call) only: the number Jarvis dialed. */
  externalTo?: string;
  /** External only: the confirmed brief — the one thing this call may carry about Sid. */
  externalBrief?: string;
  /** External only: transcript of the call with the third party (kept off Sid's conversation). */
  externalHistory: ChatMessage[];
  /** External only: set when the model called end_call; the relay closes the socket. */
  endRequested?: boolean;
}

export function newCallSession(input: {
  callerId: string;
  role: CallerRole;
  access?: string;
  guestId?: string;
  guestVerified?: boolean;
  externalTo?: string;
  externalBrief?: string;
}): CallSession {
  return {
    callId: newId("call"),
    callerId: input.callerId,
    role: input.role,
    access: input.access ?? "",
    ...(input.guestId ? { guestId: input.guestId } : {}),
    guestVerified: input.guestVerified ?? false,
    pinVerified: false,
    pinFailures: 0,
    dtmfBuffer: "",
    guestHistory: [],
    ...(input.externalTo !== undefined ? { externalTo: input.externalTo } : {}),
    ...(input.externalBrief !== undefined ? { externalBrief: input.externalBrief } : {}),
    externalHistory: [],
  };
}
