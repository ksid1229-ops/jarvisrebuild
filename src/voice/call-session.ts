import type { ChatMessage } from "../model/types.js";
import { newId } from "../ids.js";

export type CallerRole = "owner" | "guest" | "unknown";

/**
 * Per-call state. pinVerified is scoped to THIS call and resets when the call
 * ends — a PIN entered on an earlier call never authorizes a later one. Guest
 * history is kept here (never in the owner's memory) so a guest conversation is
 * coherent within the call without leaking into Sid's store.
 */
export interface CallSession {
  callId: string;
  callerId: string;
  role: CallerRole;
  /** Guest access description (what they may hear/do). Empty for owner. */
  access: string;
  pinVerified: boolean;
  /** Guest-only transcript, kept off the owner's memory. */
  guestHistory: ChatMessage[];
}

export function newCallSession(input: {
  callerId: string;
  role: CallerRole;
  access?: string;
}): CallSession {
  return {
    callId: newId("call"),
    callerId: input.callerId,
    role: input.role,
    access: input.access ?? "",
    pinVerified: false,
    guestHistory: [],
  };
}
