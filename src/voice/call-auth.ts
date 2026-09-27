import type { Clock } from "../clock.js";
import type { ToolResult } from "../jarvis/tool-types.js";
import type { CallSession } from "./call-session.js";
import type { GuestsStore } from "./guests-repo.js";
import { verifyHashedPin, type OwnerPinVerifier } from "./pin.js";

/**
 * PIN checks on a call — shared by the spoken path (the model calls a tool with
 * the digits Sid said) and the keypad path (DTMF digits collected by the voice
 * relay). Code only compares digits against a hash; it never reads intent.
 *
 * A 4-digit PIN has 10,000 values, so guessing must be bounded: after
 * MAX_PIN_FAILURES_PER_CALL wrong attempts, PIN entry is locked for the rest of
 * the call (both owner and guest). A new call starts fresh; Sid can always hang
 * up and call back.
 */
export const MAX_PIN_FAILURES_PER_CALL = 3;

function lockedResult(): ToolResult {
  return {
    ok: false,
    status: "locked",
    message: `Too many wrong PIN attempts on this call (${MAX_PIN_FAILURES_PER_CALL}). PIN entry is locked until the caller hangs up and calls again.`,
  };
}

function wrongResult(call: CallSession): ToolResult {
  const left = MAX_PIN_FAILURES_PER_CALL - call.pinFailures;
  return left <= 0
    ? lockedResult()
    : { ok: false, status: "refused", message: `PIN incorrect. ${left} attempt(s) left on this call.` };
}

/** Owner PIN on a call. Success marks THIS call pin-verified for the five actions. */
export async function verifyOwnerPinOnCall(
  call: CallSession,
  pin: string,
  verifier: OwnerPinVerifier | undefined,
): Promise<ToolResult> {
  if (call.role !== "owner") {
    return { ok: false, status: "refused", message: "The owner PIN only applies on Sid's own call." };
  }
  if (!verifier) {
    return { ok: false, status: "not_configured", message: "No owner PIN is configured; sensitive actions on a call are refused." };
  }
  if (call.pinFailures >= MAX_PIN_FAILURES_PER_CALL) return lockedResult();
  if (!(await verifier(pin))) {
    call.pinFailures += 1;
    return wrongResult(call);
  }
  call.pinVerified = true;
  return { ok: true, status: "ok", message: "PIN verified for this call." };
}

/**
 * Guest PIN on a call. Only on success does the guest's granted access enter
 * the call session (and therefore the guest prompt). The guest record is
 * re-read so a guest revoked or expired since the call started gets nothing.
 */
export async function verifyGuestPinOnCall(
  call: CallSession,
  pin: string,
  deps: { guests: GuestsStore | undefined; pepper: string | undefined; clock: Clock },
): Promise<ToolResult> {
  if (call.role !== "guest" || !call.guestId) {
    return { ok: false, status: "refused", message: "This caller is not a registered guest." };
  }
  if (!deps.guests) return { ok: false, status: "not_connected", message: "Guest registry not wired." };
  if (call.guestVerified) return { ok: true, status: "ok", message: "Guest already verified on this call." };
  if (call.pinFailures >= MAX_PIN_FAILURES_PER_CALL) return lockedResult();
  const guest = await deps.guests.get(call.guestId);
  if (!guest || Date.parse(guest.expiresAt) <= deps.clock.nowMs()) {
    return { ok: false, status: "refused", message: "This guest's access is no longer active." };
  }
  if (!(await verifyHashedPin(pin, guest.pinHash, deps.pepper ?? ""))) {
    call.pinFailures += 1;
    return wrongResult(call);
  }
  call.guestVerified = true;
  call.access = guest.access;
  return { ok: true, status: "ok", message: "Guest PIN verified. Their granted access now applies for this call." };
}

/**
 * Re-check a verified guest on every turn: a guest Sid revokes (or whose access
 * expires) mid-call loses access on the very next turn. Returns true when the
 * guest is still active.
 */
export async function guestStillActive(
  call: CallSession,
  guests: GuestsStore | undefined,
  clock: Clock,
): Promise<boolean> {
  if (!call.guestId || !guests) return false;
  const guest = await guests.get(call.guestId);
  const active = !!guest && Date.parse(guest.expiresAt) > clock.nowMs();
  if (!active) {
    call.guestVerified = false;
    call.access = "";
  }
  return active;
}
