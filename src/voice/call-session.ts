import type { ChatMessage } from "../model/types.js";
import { newId } from "../ids.js";

export type CallerRole = "owner" | "guest" | "unknown";

/**
 * Per-call state. Everything here is scoped to THIS call and is discarded when
 * the call ends — a PIN entered on an earlier call never authorizes a later one.
 * Guest history is kept here (never in the owner's memory) so a guest
 * conversation is coherent within the call without leaking into Sid's store.
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
}

export function newCallSession(input: {
  callerId: string;
  role: CallerRole;
  access?: string;
  guestId?: string;
  guestVerified?: boolean;
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
  };
}
