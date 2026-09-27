import type { Fact, Wakeup } from "../types.js";
import { safeEqual } from "../router/telegram-webhook.js";
import type { SchoolVaultSnapshot } from "../school/school-tools.js";

export interface VaultNote {
  path: string;
  markdown: string;
}

/**
 * Vault export: Jarvis is the source of truth; a Windows PC script pulls this and
 * writes markdown-with-frontmatter into Sid's Obsidian vault (one-way). It MUST
 * process EVERY note — the first build stopped at 64. This returns all facts, all
 * wake-ups and (when the School Helper is connected) the latest school evidence,
 * with no cap; the count is part of the payload so a truncation would be visible.
 *
 * Sid (2026-09-26): forgotten and corrected facts STAY in the export. Each fact
 * note carries a `status` (active / forgotten / corrected / expired) and
 * `superseded_by`, so the vault shows exactly what Jarvis does and doesn't use.
 */
export interface VaultExportOptions {
  /** The facts store's own active predicate, so "expired" matches recall exactly. */
  isActive?: (f: Fact) => boolean;
  school?: SchoolVaultSnapshot;
}

export function buildVaultExport(
  facts: Fact[],
  wakeups: Wakeup[],
  opts: VaultExportOptions = {},
): { count: number; notes: VaultNote[]; schoolUnreadable?: number } {
  const notes: VaultNote[] = [];
  for (const f of facts) {
    notes.push({
      path: `jarvis/facts/${safeName(f.id)}.md`,
      markdown: [
        "---",
        `id: ${f.id}`,
        `status: ${factStatusLabel(f, opts.isActive)}`,
        `kind: ${f.kind}`,
        `confidence: ${f.confidence}`,
        `source_type: ${f.sourceType}`,
        `created_at: ${f.createdAt}`,
        `expires_at: ${f.expiresAt ?? ""}`,
        `pinned: ${f.pinned}`,
        `hidden: ${f.hidden}`,
        `superseded_by: ${f.supersededBy ?? ""}`,
        "---",
        "",
        f.text,
        "",
      ].join("\n"),
    });
  }
  for (const w of wakeups) {
    notes.push({
      path: `jarvis/wakeups/${safeName(w.id)}.md`,
      markdown: ["---", `id: ${w.id}`, `fire_at: ${w.fireAt}`, "---", "", w.reason, ""].join("\n"),
    });
  }
  const school = opts.school;
  if (school) {
    notes.push({
      path: "jarvis/school/courses.md",
      markdown: [
        "---",
        `courses: ${school.courses.length}`,
        "---",
        "",
        "Evidence only arrives while the School Helper is open in Sid's browser; each course shows when it was last seen.",
        "",
        ...school.courses.map((c) => `- ${c.courseName ?? "(unnamed course)"} (${c.courseId ?? "?"}, ${c.host}) — evidence as of ${c.evidenceAsOf}`),
        "",
      ].join("\n"),
    });
    for (const it of school.items) {
      notes.push({
        path: `jarvis/school/items/${safeName(it.id)}.md`,
        markdown: [
          "---",
          `id: ${yaml(it.id)}`,
          `kind: ${it.kind}`,
          `course: ${yaml(it.courseName)}`,
          `course_id: ${yaml(it.courseId)}`,
          `title: ${yaml(it.title)}`,
          // null means the deadline is UNKNOWN (D2L didn't show one), never "no deadline".
          `due_at: ${it.dueAt ?? "unknown"}`,
          `status: ${yaml(it.status ?? "")}`,
          `grade: ${it.grade ?? ""}`,
          `grade_max: ${it.gradeMax ?? ""}`,
          `weight: ${it.weight ?? ""}`,
          `url: ${yaml(it.url ?? "")}`,
          `evidence_as_of: ${it.fetchedAt}`,
          "---",
          "",
          it.description ?? "",
          "",
        ].join("\n"),
      });
    }
    for (const g of school.grades) {
      notes.push({
        path: `jarvis/school/grades/${safeName(g.id)}.md`,
        markdown: [
          "---",
          `id: ${yaml(g.id)}`,
          `course: ${yaml(g.courseName)}`,
          `item: ${yaml(g.name)}`,
          `grade: ${g.grade ?? ""}`,
          `grade_max: ${g.gradeMax ?? ""}`,
          `weight: ${g.weight ?? ""}`,
          `last_modified: ${g.lastModified ?? ""}`,
          `evidence_as_of: ${g.fetchedAt}`,
          "---",
          "",
          g.comments ?? "",
          "",
        ].join("\n"),
      });
    }
  }
  return {
    count: notes.length,
    notes,
    ...(school && school.unreadable > 0 ? { schoolUnreadable: school.unreadable } : {}),
  };
}

function factStatusLabel(f: Fact, isActive?: (f: Fact) => boolean): "active" | "forgotten" | "corrected" | "expired" {
  if (f.hidden) return "forgotten";
  if (f.supersededBy) return "corrected";
  if (isActive && !isActive(f)) return "expired";
  return "active";
}

/** A filename-safe version of an id (D2L ids can hold ':' or '/'). */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** A YAML-safe scalar: JSON strings are valid YAML double-quoted strings. */
function yaml(v: string): string {
  return JSON.stringify(v);
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
