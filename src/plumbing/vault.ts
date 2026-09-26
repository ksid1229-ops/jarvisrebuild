import type { Fact, Wakeup } from "../types.js";
import { safeEqual } from "../router/telegram-webhook.js";

export interface VaultNote {
  path: string;
  markdown: string;
}

/**
 * Vault export: Jarvis is the source of truth; a Windows PC script pulls this and
 * writes markdown-with-frontmatter into Sid's Obsidian vault (one-way). It MUST
 * process EVERY note — the first build stopped at 64. This returns all facts and
 * all wake-ups with no cap, and the count is part of the payload so a truncation
 * would be visible.
 */
export function buildVaultExport(facts: Fact[], wakeups: Wakeup[]): { count: number; notes: VaultNote[] } {
  const notes: VaultNote[] = [];
  for (const f of facts) {
    notes.push({
      path: `jarvis/facts/${f.id}.md`,
      markdown: [
        "---",
        `id: ${f.id}`,
        `kind: ${f.kind}`,
        `confidence: ${f.confidence}`,
        `source_type: ${f.sourceType}`,
        `created_at: ${f.createdAt}`,
        `expires_at: ${f.expiresAt ?? ""}`,
        `pinned: ${f.pinned}`,
        `hidden: ${f.hidden}`,
        "---",
        "",
        f.text,
        "",
      ].join("\n"),
    });
  }
  for (const w of wakeups) {
    notes.push({
      path: `jarvis/wakeups/${w.id}.md`,
      markdown: ["---", `id: ${w.id}`, `fire_at: ${w.fireAt}`, "---", "", w.reason, ""].join("\n"),
    });
  }
  return { count: notes.length, notes };
}

/**
 * The /vault/export endpoint is protected by a secret token. FAIL CLOSED: with no
 * token configured, every request is refused (never an open export of Sid's data).
 */
export function authorizeVaultExport(providedToken: string | null, configuredToken: string | undefined): boolean {
  if (!configuredToken || configuredToken.trim() === "") return false;
  if (!providedToken) return false;
  return safeEqual(providedToken, configuredToken);
}
