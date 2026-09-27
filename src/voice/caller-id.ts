import type { GuestsStore } from "./guests-repo.js";
import { newCallSession, type CallSession } from "./call-session.js";

/**
 * Identify a caller by phone number: owner, guest, or unknown. Caller ID alone
 * can be spoofed, so it only decides which PROMPT the caller starts with:
 *  - owner: Sid's brain. The five actions still require the owner PIN on the call.
 *  - guest: a guest-PIN prompt ONLY. The guest's granted access is withheld until
 *    they enter their own 4-digit guest PIN (verifyGuestPinOnCall). A spoofed
 *    guest number therefore learns nothing.
 *  - unknown: a minimal prompt with no access at all.
 *
 * FAIL CLOSED: with no configured owner phone, a caller is never treated as the
 * owner.
 */
export async function identifyCaller(
  fromNumber: string,
  ownerPhoneE164: string | undefined,
  guests: GuestsStore,
): Promise<CallSession> {
  if (ownerPhoneE164 && fromNumber === ownerPhoneE164) {
    return newCallSession({ callerId: fromNumber, role: "owner" });
  }
  const guest = await guests.activeByPhone(fromNumber);
  if (guest) {
    // Deliberately NO access here — see verifyGuestPinOnCall.
    return newCallSession({ callerId: fromNumber, role: "guest", guestId: guest.id });
  }
  return newCallSession({ callerId: fromNumber, role: "unknown" });
}
