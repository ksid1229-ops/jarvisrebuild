/**
 * Embeddings + a vector index for meaning search.
 *
 * Production uses Workers AI for embeddings and Vectorize for the index. In the
 * sandbox neither runs, so a deterministic fake stands in (see PROGRESS.md:
 * "faked"). The fake is honest about being a bag-of-words cosine, not a real
 * semantic model — but it is enough to prove the recall PATH: index a fact,
 * search a related query, get it back, and never get hidden/expired facts.
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
