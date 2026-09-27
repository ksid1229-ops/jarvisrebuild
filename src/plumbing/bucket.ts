/**
 * A tiny object-store interface. Production binds R2; the sandbox uses
 * InMemoryBucket. Backup, archive and vault all talk to this, so swapping in R2
 * is a one-line change with no logic change.
 */
export interface Bucket {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(prefix?: string): Promise<string[]>;
}

export class InMemoryBucket implements Bucket {
  private readonly objects = new Map<string, string>();
  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }
  async list(prefix = ""): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** The slice of the R2Bucket binding this adapter uses. */
export interface R2Like {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(opts: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * Adapter over a real R2 bucket. R2's list() returns at most 1000 keys per call;
 * this follows `cursor` until `truncated` is false, so a listing is never
 * silently cut at the first page (tested against a paging fake).
 */
export class R2BucketAdapter implements Bucket {
  constructor(private readonly r2: R2Like) {}
  async put(key: string, value: string): Promise<void> {
    await this.r2.put(key, value);
  }
  async get(key: string): Promise<string | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    return obj.text();
  }
  async list(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100_000; page++) {
      const res = await this.r2.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const o of res.objects) keys.push(o.key);
      if (!res.truncated) return keys.sort();
      if (!res.cursor) throw new Error("R2 list reported truncated without a cursor");
      cursor = res.cursor;
    }
    throw new Error("R2 list did not finish (runaway page cap)");
  }
}
