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

/** Thin adapter over a real R2 bucket (not exercised in the sandbox). */
export class R2BucketAdapter implements Bucket {
  constructor(private readonly r2: { put: Function; get: Function; list: Function }) {}
  async put(key: string, value: string): Promise<void> {
    await this.r2.put(key, value);
  }
  async get(key: string): Promise<string | null> {
    const obj = await this.r2.get(key);
    if (!obj) return null;
    return typeof obj.text === "function" ? await obj.text() : String(obj);
  }
  async list(prefix = ""): Promise<string[]> {
    const res = await this.r2.list({ prefix });
    return (res?.objects ?? []).map((o: { key: string }) => o.key);
  }
}
