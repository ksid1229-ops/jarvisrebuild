import type { Clock } from "../clock.js";
import type { Tool, ToolContext, ToolResult } from "../jarvis/tool-types.js";
import type { Bucket } from "./bucket.js";
import { newId } from "../ids.js";

export interface ArchiveEntry {
  id: string;
  at: string;
  role: string;
  content: string;
  channel: string;
}

/**
 * Every conversation message (texts and call transcripts) copied to R2 by date,
 * searchable. The agent core appends every stored message as it happens.
 *
 * One object per message (archive/YYYY-MM-DD/<at>_<id>.json): appends never
 * read-modify-write a shared daily file, so two overlapping turns cannot lose
 * each other's lines. Search reads only the days inside the requested range, and
 * processes ALL matches up to a high system-protection cap that REPORTS drops.
 */
export class ArchiveService {
  constructor(private readonly bucket: Bucket, private readonly clock: Clock) {}

  async append(entry: Omit<ArchiveEntry, "at" | "id"> & { at?: string; id?: string }): Promise<string> {
    const at = entry.at ?? this.clock.nowIso();
    const id = entry.id ?? newId("arc");
    const key = `archive/${at.slice(0, 10)}/${at}_${id}.json`;
    const record: ArchiveEntry = { id, at, role: entry.role, content: entry.content, channel: entry.channel };
    await this.bucket.put(key, JSON.stringify(record));
    return key;
  }

  async search(query: string, range?: { fromIso?: string; toIso?: string }): Promise<{ results: ArchiveEntry[]; dropped: number }> {
    const from = range?.fromIso ? new Date(range.fromIso).getTime() : -Infinity;
    const to = range?.toIso ? new Date(range.toIso).getTime() : Infinity;
    const fromDay = range?.fromIso ? new Date(range.fromIso).toISOString().slice(0, 10) : "";
    const toDay = range?.toIso ? new Date(range.toIso).toISOString().slice(0, 10) : "9999-12-31";
    const q = query.toLowerCase();
    const keys = await this.keysFor(fromDay, toDay);
    const matches: ArchiveEntry[] = [];
    for (const key of keys) {
      const day = key.slice("archive/".length, "archive/".length + 10);
      if (day < fromDay || day > toDay) continue;
      const blob = await this.bucket.get(key);
      if (!blob) continue;
      const entry = JSON.parse(blob) as ArchiveEntry;
      const t = new Date(entry.at).getTime();
      if (t < from || t > to) continue;
      if (entry.content.toLowerCase().includes(q)) matches.push(entry);
    }
    const HARD_CAP = 500;
    return { results: matches.slice(0, HARD_CAP), dropped: Math.max(0, matches.length - HARD_CAP) };
  }

  /** A bounded range lists only its days; an open range lists everything. */
  private async keysFor(fromDay: string, toDay: string): Promise<string[]> {
    if (fromDay === "" || toDay === "9999-12-31") return this.bucket.list("archive/");
    const start = Date.parse(`${fromDay}T00:00:00.000Z`);
    const end = Date.parse(`${toDay}T00:00:00.000Z`);
    const days = Math.round((end - start) / 86_400_000) + 1;
    if (days > 400) return this.bucket.list("archive/");
    const keys: string[] = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      keys.push(...(await this.bucket.list(`archive/${day}/`)));
    }
    return keys;
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
