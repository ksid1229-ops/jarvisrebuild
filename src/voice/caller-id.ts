import type { GuestsRepo } from "./guests-repo.js";
import { newCallSession, type CallSession } from "./call-session.js";

/**
 * Identify a caller by phone number: owner, guest, or unknown. Caller ID alone
 * can be spoofed, which is why the five actions still require the PIN on a call —
 * this only decides which PROMPT and which tools the caller gets, never whether a
 * sensitive action may run.
 *
 * FAIL CLOSED: with no configured owner phone, a caller is never treated as the
 * owner.
 */
export function identifyCaller(
  fromNumber: string,
  ownerPhoneE164: string | undefined,
  guests: GuestsRepo,
): CallSession {
  if (ownerPhoneE164 && fromNumber === ownerPhoneE164) {
    return newCallSession({ callerId: fromNumber, role: "owner" });
  }
  const guest = guests.activeByPhone(fromNumber);
  if (guest) {
    return newCallSession({ callerId: fromNumber, role: "guest", access: guest.access });
  }
  return newCallSession({ callerId: fromNumber, role: "unknown" });
}
