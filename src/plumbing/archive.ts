import type { Clock } from "../clock.js";
import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";
import type { Bucket } from "./bucket.js";

export interface ArchiveEntry {
  at: string;
  role: string;
  content: string;
  channel: string;
}

/**
 * Every conversation (texts and call transcripts) saved to R2 by date, and
 * searchable. It processes ALL matching entries across the date range (with a
 * high system-protection cap that REPORTS anything dropped), never a silent
 * subset.
 */
export class ArchiveService {
  constructor(private readonly bucket: Bucket, private readonly clock: Clock) {}

  private keyFor(iso: string): string {
    return `archive/${iso.slice(0, 10)}.jsonl`;
  }

  async append(entry: Omit<ArchiveEntry, "at"> & { at?: string }): Promise<void> {
    const at = entry.at ?? this.clock.nowIso();
    const key = this.keyFor(at);
    const existing = (await this.bucket.get(key)) ?? "";
    const line = JSON.stringify({ at, role: entry.role, content: entry.content, channel: entry.channel });
    await this.bucket.put(key, existing === "" ? line : `${existing}\n${line}`);
  }

  async search(query: string, range?: { fromIso?: string; toIso?: string }): Promise<{ results: ArchiveEntry[]; dropped: number }> {
    const from = range?.fromIso ? new Date(range.fromIso).getTime() : -Infinity;
    const to = range?.toIso ? new Date(range.toIso).getTime() : Infinity;
    const q = query.toLowerCase();
    const keys = await this.bucket.list("archive/");
    const matches: ArchiveEntry[] = [];
    for (const key of keys) {
      const blob = await this.bucket.get(key);
      if (!blob) continue;
      for (const line of blob.split("\n")) {
        if (line.trim() === "") continue;
        const entry = JSON.parse(line) as ArchiveEntry;
        const t = new Date(entry.at).getTime();
        if (t < from || t > to) continue;
        if (entry.content.toLowerCase().includes(q)) matches.push(entry);
      }
    }
    const HARD_CAP = 500;
    return { results: matches.slice(0, HARD_CAP), dropped: Math.max(0, matches.length - HARD_CAP) };
  }
}

export const archiveSearch: Tool = {
  name: "archive_search",
  description:
    "Search the full conversation archive (texts and call transcripts) by date. Use it to find older " +
    "exchanges beyond recent history. query: words to look for. from/to: optional RFC3339 UTC bounds.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
    required: ["query"],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.archive) return { ok: false, status: "not_connected", message: "Archive not wired." };
    const query = String(args.query ?? "");
    if (query.trim() === "") return { ok: false, status: "refused", message: "query is required." };
    const range: { fromIso?: string; toIso?: string } = {};
    if (typeof args.from === "string") range.fromIso = args.from;
    if (typeof args.to === "string") range.toIso = args.to;
    const { results, dropped } = await ctx.archive.search(query, range);
    return { ok: true, status: "ok", data: { results, dropped } };
  },
};
