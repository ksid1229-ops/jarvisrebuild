/**
 * Embeddings + a vector index for meaning search.
 *
 * Production: WorkersAiEmbeddingProvider (env.AI) + CloudflareVectorizeIndex
 * (env.MEMORY_VECTORS). Both are adapters over Cloudflare bindings; the sandbox
 * cannot reach Cloudflare, so tests drive them through fakes shaped like the
 * real bindings. The Worker NEVER falls back to the bag-of-words fake: without
 * the AI binding it uses UnavailableEmbeddingProvider, which fails loudly.
 *
 * Tests use FakeEmbeddingProvider (a deterministic bag-of-words cosine, not a
 * semantic model) + InMemoryVectorIndex, which prove the recall PATH only.
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** Deterministic bag-of-words embedding into a fixed-dimension vector. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dim = 256) {}
  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dim).fill(0);
    for (const token of tokenize(text)) {
      const h = hashToken(token) % this.dim;
      vec[h] = (vec[h] ?? 0) + 1;
    }
    return normalize(vec);
  }
}

/** Real Workers AI embeddings. Not exercised in the sandbox. */
export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly ai: { run(model: string, input: unknown): Promise<any> },
    private readonly model = "@cf/baai/bge-base-en-v1.5",
  ) {}
  async embed(text: string): Promise<number[]> {
    const res = await this.ai.run(this.model, { text: [text] });
    const data = res?.data?.[0];
    if (!Array.isArray(data)) throw new Error("Workers AI embedding returned no vector");
    return normalize(data as number[]);
  }
}

/**
 * Used when the Workers AI binding is missing. Meaning search and indexing then
 * fail with this message instead of silently using a keyword fake.
 */
export class UnavailableEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly why = "not connected: the Workers AI binding (AI) is missing") {}
  async embed(): Promise<number[]> {
    throw new Error(this.why);
  }
}

export interface VectorHit {
  id: string;
  score: number;
}

export interface VectorIndex {
  upsert(id: string, vector: number[]): Promise<void>;
  remove(id: string): Promise<void>;
  /** Return topK nearest ids with scores, highest first. */
  query(vector: number[], topK: number): Promise<VectorHit[]>;
}

export class InMemoryVectorIndex implements VectorIndex {
  private readonly vectors = new Map<string, number[]>();
  async upsert(id: string, vector: number[]): Promise<void> {
    this.vectors.set(id, vector);
  }
  async remove(id: string): Promise<void> {
    this.vectors.delete(id);
  }
  async query(vector: number[], topK: number): Promise<VectorHit[]> {
    const hits: VectorHit[] = [];
    for (const [id, v] of this.vectors) {
      hits.push({ id, score: cosine(vector, v) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}

/** The slice of the Vectorize binding this adapter uses (Vectorize V2 API). */
export interface VectorizeLike {
  upsert(vectors: { id: string; values: number[] }[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(vector: number[], opts: { topK: number; returnValues?: boolean; returnMetadata?: string | boolean }): Promise<{
    matches: { id: string; score: number }[];
  }>;
}

/**
 * Real Vectorize index. Vectors persist outside the Durable Object, so meaning
 * search survives evictions and redeploys (the in-memory index did not).
 * Vectorize applies mutations asynchronously: a just-saved fact can take a few
 * seconds to become searchable. The ledger (D1) is always the source of truth;
 * every hit is re-checked against it before it reaches the model.
 */
export class CloudflareVectorizeIndex implements VectorIndex {
  /** Vectorize's own topK ceiling when values/metadata are not returned. */
  static readonly MAX_TOP_K = 100;
  constructor(private readonly index: VectorizeLike) {}
  async upsert(id: string, vector: number[]): Promise<void> {
    await this.index.upsert([{ id, values: vector }]);
  }
  async remove(id: string): Promise<void> {
    await this.index.deleteByIds([id]);
  }
  async query(vector: number[], topK: number): Promise<VectorHit[]> {
    const k = Math.max(1, Math.min(topK, CloudflareVectorizeIndex.MAX_TOP_K));
    const res = await this.index.query(vector, { topK: k, returnValues: false, returnMetadata: "none" });
    return (res.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
  }
}

/**
 * Re-index active facts that are not in the meaning index yet (the index was
 * down when they were saved, or they predate Vectorize). Runs hourly. Every
 * failure is counted and returned; nothing is dropped quietly.
 */
export async function reindexUnindexed(
  facts: import("./facts-repo.js").FactsStore,
  embeddings: EmbeddingProvider,
  vectors: VectorIndex,
  cap = 100,
): Promise<{ indexed: number; failed: { id: string; error: string }[]; remaining: number }> {
  const { facts: batch, total } = await facts.unindexedActive(cap);
  let indexed = 0;
  const failed: { id: string; error: string }[] = [];
  for (const f of batch) {
    try {
      await vectors.upsert(f.id, await embeddings.embed(f.text));
      await facts.markIndexed(f.id, true);
      indexed += 1;
    } catch (e) {
      failed.push({ id: f.id, error: (e as Error).message });
    }
  }
  return { indexed, failed, remaining: total - indexed };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (mag === 0) return vec;
  return vec.map((x) => x / mag);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot; // both already normalized
}
