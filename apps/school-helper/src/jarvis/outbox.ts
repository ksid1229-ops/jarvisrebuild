/**
 * The local outbox: nothing is reported as sent until the receiver says so.
 *
 * Bounds match the collector's, because the receiver's retry/duplicate
 * behaviour was designed against them:
 *   - newest 2 batches per host+course (a newer read supersedes an older one)
 *   - 1 MiB of serialized entries, oldest evicted first
 *   - at most 8 upload attempts per flush
 *
 * Two honesty rules are enforced here rather than left to callers:
 *   1. A failed push stays queued and is retried with backoff. It is never
 *      counted as delivered.
 *   2. An eviction is never silent. Every dropped entry increments a counter
 *      that the link log and the dashboard warning both read.
 */

export const QUEUE_PER_COURSE = 2;
export const QUEUE_MAX_BYTES = 1024 * 1024;
export const FLUSH_ATTEMPTS = 8;

/** Backoff for a failing entry: 1m, 5m, 15m, 1h, then 6h forever. */
export const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];

export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
}

import type { JarvisOutboxEntry as OutboxEntry } from '../common/types';

export type { OutboxEntry };

const encoder = new TextEncoder();
const bytesOf = (queue: OutboxEntry[]): number => encoder.encode(JSON.stringify(queue)).length;

export interface PruneResult {
  queue: OutboxEntry[];
  evicted: number;
  /** Ids that were dropped, so they can be named in the log. */
  evictedIds: string[];
}

/**
 * Applies both bounds. Supersede-by-course runs first so an outage cannot
 * preserve unbounded growth, then the byte cap trims the oldest.
 */
export function prune(entries: OutboxEntry[]): PruneResult {
  const counts = new Map<string, number>();
  const kept = entries
    .slice()
    .reverse()
    .filter((entry) => {
      const key = JSON.stringify([entry.host, entry.courseId]);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= QUEUE_PER_COURSE;
    })
    .reverse();

  let bytes = bytesOf(kept);
  while (bytes > QUEUE_MAX_BYTES && kept.length) {
    const removed = kept.shift();
    bytes -= bytesOf(removed ? [removed] : []) + (kept.length ? 1 : 0);
  }

  const keptIds = new Set(kept.map((e) => e.id));
  return {
    queue: kept,
    evicted: entries.length - kept.length,
    evictedIds: entries.filter((e) => !keptIds.has(e.id)).map((e) => e.id),
  };
}

export interface FlushDeps {
  send: (entry: OutboxEntry) => Promise<{ batchId: string; outcome: 'good' | 'failed' }>;
  clock: () => number;
  /** false when a read was interrupted: queue is persisted, nothing is sent. */
  sendPending?: boolean;
  paired?: boolean;
}

export interface FlushResult {
  queue: OutboxEntry[];
  sent: number;
  failed: number;
  evicted: number;
  attempted: number;
  error: string | null;
}

/**
 * One flush pass. Returns the queue to persist — the caller commits once, so a
 * worker killed mid-run cannot leave a half-written queue.
 */
export async function flush(entries: OutboxEntry[], deps: FlushDeps): Promise<FlushResult> {
  const { send, clock, sendPending = true, paired = true } = deps;
  const { queue, evicted } = prune(entries);
  let sent = 0;
  let failed = 0;
  let attempted = 0;

  if (sendPending && paired) {
    for (const entry of [...queue]) {
      if (attempted >= FLUSH_ATTEMPTS) break;
      if (entry.nextAttemptAt > clock()) continue;
      attempted += 1;
      try {
        const receipt = await send(entry);
        if (!receipt?.batchId || !['good', 'failed'].includes(receipt.outcome))
          throw new Error('invalid-receipt');
        queue.splice(queue.indexOf(entry), 1);
        sent += 1;
      } catch (error) {
        failed += 1;
        entry.attempts += 1;
        entry.lastError = (error as Error).message;
        entry.nextAttemptAt = clock() + backoffFor(entry.attempts);
      }
    }
  }

  const error = !sendPending
    ? 'read-interrupted'
    : !paired
      ? 'pairing-required'
      : queue.length
        ? 'push-refused-or-unavailable'
        : null;

  return { queue, sent, failed, evicted, attempted, error };
}
