/**
 * The guest prompt. A guest gets NONE of Sid's profile, persona, memory or
 * tools — only what their access describes. The first build leaked Sid's pinned
 * facts into guest-call prompts; this prompt is built from scratch and never
 * touches the core profile.
 */
export function buildGuestPrompt(input: { access: string; nowIso: string; timezone: string }): string {
  const local = safeLocal(input.nowIso, input.timezone);
  const access = input.access.trim() === "" ? "(no specific access was granted)" : input.access;
  return [
    "You are Jarvis answering a phone call from a GUEST — not Sid. You are polite, brief, and spoken.",
    "You do NOT know anything about Sid beyond what this guest has been explicitly granted below.",
    "You never reveal Sid's personal facts, codes, numbers, schedule, or any memory. If asked for",
    "something outside the granted access, say you can't share that. You have no tools on this call.",
    "",
    "WHAT THIS GUEST MAY ACCESS:",
    access,
    "",
    `Current time: ${local} (${input.timezone}). Speak naturally, no lists.`,
  ].join("\n");
}

/**
 * The prompt for a caller whose number matches a registered guest but who has
 * NOT yet entered their guest PIN. It carries no access at all — not even the
 * guest's name — because caller ID can be spoofed. Its only tool is
 * guest_pin_verify; the keypad path verifies digits in code without the model.
 */
export function buildGuestPinPrompt(input: { nowIso: string; timezone: string; revoked?: boolean }): string {
  const local = safeLocal(input.nowIso, input.timezone);
  const lines = [
    "You are Jarvis answering a phone call. The caller's number is registered for guest access,",
    "but phone numbers can be faked, so nothing is shared until the caller proves who they are with",
    "their own 4-digit guest PIN. Ask for it. They can say it or type it on the keypad. When they say",
    "digits, call guest_pin_verify with exactly those four digits. You know NOTHING about Sid and must",
    "not guess, hint, or confirm anything about him. Do not say whose phone this is.",
  ];
  if (input.revoked) {
    lines.push("", "This caller's guest access has just been revoked or has expired. Tell them politely you can't help further.");
  }
  lines.push("", `Current time: ${local} (${input.timezone}). Speak naturally and briefly.`);
  return lines.join("\n");
}

function safeLocal(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
