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
