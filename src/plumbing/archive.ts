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

  async search(
    query: string,
    range?: { fromIso?: string; toIso?: string },
    page: { limit?: number; offset?: number } = {},
  ): Promise<{ results: ArchiveEntry[]; total: number; nextOffset: number | null }> {
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
    // No count cap (Sid: Jarvis gets as much as he needs). Paging is the model's choice.
    matches.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const offset = page.offset ?? 0;
    const results = matches.slice(offset, page.limit === undefined ? undefined : offset + page.limit);
    const shown = offset + results.length;
    return { results, total: matches.length, nextOffset: shown < matches.length ? shown : null };
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
    "Search the full conversation archive (texts and call transcripts) by date, oldest first. Use it " +
    "to find older exchanges beyond recent history. query: words to look for. from/to: optional " +
    "RFC3339 UTC bounds. limit/offset: optional — leave limit out to get every match.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "number", description: "Optional: how many you want. Leave it out to get every match." },
      offset: { type: "number", description: "Optional: skip this many first (paging)." },
    },
    required: ["query"],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.archive) return { ok: false, status: "not_connected", message: "Archive not wired." };
    const query = String(args.query ?? "");
    if (query.trim() === "") return { ok: false, status: "refused", message: "query is required." };
    const range: { fromIso?: string; toIso?: string } = {};
    for (const [k, key] of [["from", "fromIso"], ["to", "toIso"]] as const) {
      if (args[k] === undefined) continue;
      if (typeof args[k] !== "string" || Number.isNaN(Date.parse(args[k] as string))) {
        return { ok: false, status: "refused", message: `${k} is not a real date: ${JSON.stringify(args[k])}` };
      }
      range[key] = args[k] as string;
    }
    const page: { limit?: number; offset?: number } = {};
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isFinite(args.limit) || args.limit < 1) {
        return { ok: false, status: "refused", message: `limit must be a whole number of at least 1: ${JSON.stringify(args.limit)}` };
      }
      page.limit = Math.floor(args.limit);
    }
    if (args.offset !== undefined) {
      if (typeof args.offset !== "number" || !Number.isFinite(args.offset) || args.offset < 0) {
        return { ok: false, status: "refused", message: `offset must be a whole number of at least 0: ${JSON.stringify(args.offset)}` };
      }
      page.offset = Math.floor(args.offset);
    }
    const r = await ctx.archive.search(query, range, page);
    return { ok: true, status: "ok", data: r };
  },
};
