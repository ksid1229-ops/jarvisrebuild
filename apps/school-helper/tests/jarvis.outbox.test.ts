import { beforeEach, describe, expect, it } from 'vitest';
import { db, saveSettings } from '../src/common/db';
import type { JarvisOutboxEntry } from '../src/common/types';
import { BACKOFF_MS, FLUSH_ATTEMPTS, QUEUE_PER_COURSE, backoffFor, flush, prune } from '../src/jarvis/outbox';
import { enqueueBatch, flushOutboxNow, linkWarning, readLog } from '../src/jarvis/link';
import type { ObservationBatch } from '../src/jarvis/evidence';
import { GatewayTransport } from '../src/jarvis/transport';
import { FakeJarvis, memoryStore } from './fake-jarvis';

let counter = 0;
function entry(overrides: Partial<JarvisOutboxEntry> = {}): JarvisOutboxEntry {
  counter += 1;
  return {
    id: `e${counter}`,
    body: '{"a":1}',
    host: 'ldsb.elearningontario.ca',
    courseId: '1001',
    readId: `read-${counter}`,
    itemCount: 7,
    createdAt: counter,
    attempts: 0,
    nextAttemptAt: 0,
    ...overrides,
  };
}

function batch(courseId: string, readId: string, routes = 7): ObservationBatch {
  return {
    schemaVersion: '1.0',
    host: 'ldsb.elearningontario.ca',
    readId,
    startedAt: '2026-09-26T12:00:00.000Z',
    courseIds: [courseId],
    enrollmentComplete: true,
    course: { id: courseId, name: `Course ${courseId}` },
    routes: Array.from({ length: routes }, (_, i) => ({
      route: `/d2l/api/le/1.82/${courseId}/thing/${i}`,
      status: 200,
      fetchedAt: '2026-09-26T12:00:01.000Z',
      complete: true,
      body: [{ Id: i }],
    })),
  };
}

beforeEach(async () => {
  counter = 0;
  await Promise.all([db.jarvisOutbox.clear(), db.jarvisLog.clear(), db.settings.clear()]);
});

describe('outbox bounds', () => {
  it('keeps only the newest two batches per host+course', () => {
    const entries = [
      entry({ courseId: 'A' }),
      entry({ courseId: 'A' }),
      entry({ courseId: 'A' }),
      entry({ courseId: 'B' }),
    ];
    const { queue, evicted } = prune(entries);
    expect(evicted).toBe(1);
    expect(queue.filter((e) => e.courseId === 'A')).toHaveLength(QUEUE_PER_COURSE);
    // The newest survive.
    expect(queue.map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
  });

  it('does not let one course evict another board\u2019s copy of the same course', () => {
    const entries = [
      entry({ courseId: 'A', host: 'ldsb.elearningontario.ca' }),
      entry({ courseId: 'A', host: 'ldsb.elearningontario.ca' }),
      entry({ courseId: 'A', host: 'durham.elearningontario.ca' }),
    ];
    expect(prune(entries).evicted).toBe(0);
  });

  it('drops the OLDEST first when the byte cap is hit, and says how many', () => {
    const big = 'x'.repeat(300_000);
    const entries = [
      entry({ courseId: 'A', body: big }),
      entry({ courseId: 'B', body: big }),
      entry({ courseId: 'C', body: big }),
      entry({ courseId: 'D', body: big }),
      entry({ courseId: 'E', body: big }),
    ];
    const { queue, evicted, evictedIds } = prune(entries);
    expect(evicted).toBeGreaterThan(0);
    expect(evictedIds).toContain('e1');
    expect(queue.at(-1)!.courseId).toBe('E');
  });
});

describe('outbox retry', () => {
  it('RETRY: a failed push stays queued, is counted as failed, and backs off', async () => {
    const entries = [entry()];
    const result = await flush(entries, {
      clock: () => 1000,
      send: async () => {
        throw new Error('gateway-refused-500');
      },
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].attempts).toBe(1);
    expect(result.queue[0].lastError).toBe('gateway-refused-500');
    expect(result.queue[0].nextAttemptAt).toBe(1000 + BACKOFF_MS[1]);
    expect(result.error).toBe('push-refused-or-unavailable');
  });

  it('RETRY: the same entry succeeds on a later attempt and leaves the queue', async () => {
    let attempt = 0;
    const entries = [entry()];
    const first = await flush(entries, {
      clock: () => 0,
      send: async () => {
        attempt += 1;
        throw new Error('boom');
      },
    });
    expect(first.queue).toHaveLength(1);

    const second = await flush(first.queue, {
      clock: () => 10_000_000, // past the backoff
      send: async () => ({ batchId: 'b1', outcome: 'good' as const }),
    });
    expect(attempt).toBe(1);
    expect(second.sent).toBe(1);
    expect(second.queue).toHaveLength(0);
    expect(second.error).toBeNull();
  });

  it('RETRY: an entry still inside its backoff window is skipped, not retried', async () => {
    let calls = 0;
    const entries = [entry({ attempts: 2, nextAttemptAt: 9_000 })];
    const result = await flush(entries, {
      clock: () => 1_000,
      send: async () => {
        calls += 1;
        return { batchId: 'b', outcome: 'good' as const };
      },
    });
    expect(calls).toBe(0);
    expect(result.attempted).toBe(0);
    expect(result.queue).toHaveLength(1);
  });

  it('backoff grows then plateaus, and never reaches zero', () => {
    expect(backoffFor(1)).toBe(300_000);
    expect(backoffFor(99)).toBe(BACKOFF_MS.at(-1));
    expect(BACKOFF_MS.every((ms) => ms > 0)).toBe(true);
  });

  it('caps one flush at eight uploads', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry({ courseId: `C${i}` }));
    let sent = 0;
    const result = await flush(entries, {
      clock: () => 1,
      send: async () => {
        sent += 1;
        return { batchId: 'b', outcome: 'good' as const };
      },
    });
    expect(sent).toBe(FLUSH_ATTEMPTS);
    expect(result.queue).toHaveLength(20 - FLUSH_ATTEMPTS);
  });

  it('sends nothing and reports pairing-required when not paired', async () => {
    let sent = 0;
    const result = await flush([entry()], {
      clock: () => 1,
      paired: false,
      send: async () => {
        sent += 1;
        return { batchId: 'b', outcome: 'good' as const };
      },
    });
    expect(sent).toBe(0);
    expect(result.error).toBe('pairing-required');
    expect(result.queue).toHaveLength(1);
  });

  it('an interrupted read persists the queue without sending', async () => {
    const result = await flush([entry()], {
      clock: () => 1,
      sendPending: false,
      send: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result.error).toBe('read-interrupted');
    expect(result.queue).toHaveLength(1);
  });
});

describe('outbox end to end, through the link service', () => {
  async function linked(options: { autoApprove?: boolean; failNext?: number } = {}) {
    const fake = new FakeJarvis({ autoApprove: options.autoApprove ?? true, failNext: options.failNext });
    const store = memoryStore();
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    const start = await transport.startPairing('Home PC');
    await store.set('pairing', { ...start, status: 'pending' });
    await transport.provePairing();
    await store.set('pairing', { ...start, status: 'active' });
    await saveSettings({
      jarvis: { enabled: true, transport: 'gateway', baseUrl: 'https://gateway.test', appId: 'school-helper', failureStreak: 0, droppedTotal: 0 },
    });
    return { fake, store, transport };
  }

  it('queues a batch, sends it, and empties the queue', async () => {
    const { fake, store, transport } = await linked();
    await enqueueBatch(batch('1001', 'r1'));
    expect(await db.jarvisOutbox.count()).toBe(1);

    const result = await flushOutboxNow({ transport, store });
    expect(result.sent).toBe(1);
    expect(result.error).toBeNull();
    expect(await db.jarvisOutbox.count()).toBe(0);
    expect(fake.batches).toHaveLength(1);
  });

  it('a 500 leaves the batch queued and raises a warning after three flushes', async () => {
    const { store, transport } = await linked({ failNext: 99 });
    await enqueueBatch(batch('1001', 'r1'));

    for (let i = 0; i < 3; i += 1) {
      await db.jarvisOutbox.toCollection().modify({ nextAttemptAt: 0 });
      await flushOutboxNow({ transport, store });
    }
    expect(await db.jarvisOutbox.count()).toBe(1);
    const warning = await linkWarning();
    expect(warning).toMatch(/failed 3 times in a row/);
    expect(warning).toMatch(/1 batch still queued/);
  });

  it('never reports success that did not happen', async () => {
    const { store, transport } = await linked({ failNext: 99 });
    await enqueueBatch(batch('1001', 'r1'));
    const result = await flushOutboxNow({ transport, store });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    const log = await readLog();
    expect(log.some((e) => e.ok === false)).toBe(true);
    expect(log.every((e) => !(e.ok === true && e.itemCount > 0))).toBe(true);
  });

  it('DROPS ARE NEVER SILENT: an evicted batch is counted, logged and surfaced', async () => {
    const { store, transport } = await linked();
    // Three reads of one course; the oldest is superseded.
    await enqueueBatch(batch('1001', 'r1'));
    await enqueueBatch(batch('1001', 'r2'));
    await enqueueBatch(batch('1001', 'r3'));
    expect(await db.jarvisOutbox.count()).toBe(3);

    const result = await flushOutboxNow({ transport, store });
    expect(result.evicted).toBe(1);

    const log = await readLog();
    expect(log.some((e) => e.detail === 'queue-evicted-1')).toBe(true);

    // Nothing left queued after a good flush, but the drop is still on record.
    await db.jarvisOutbox.clear();
    await saveSettings({
      jarvis: { enabled: true, transport: 'gateway', baseUrl: 'https://gateway.test', appId: 'school-helper', failureStreak: 0, droppedTotal: 1 },
    });
    expect(await linkWarning()).toMatch(/dropped 1 queued batch/);
  });

  it('bounds the queue even while the link is switched off', async () => {
    await saveSettings({
      jarvis: { enabled: false, transport: 'gateway', baseUrl: 'https://gateway.test', appId: 'school-helper', failureStreak: 0, droppedTotal: 0 },
    });
    await enqueueBatch(batch('1001', 'r1'));
    await enqueueBatch(batch('1001', 'r2'));
    await enqueueBatch(batch('1001', 'r3'));
    const result = await flushOutboxNow({ store: memoryStore() });
    expect(result.error).toBe('link-disabled');
    expect(result.sent).toBe(0);
    expect(result.evicted).toBe(1);
    expect(await db.jarvisOutbox.count()).toBe(QUEUE_PER_COURSE);
  });

  it('an oversized batch becomes an explicit compact failure, never a truncated success', async () => {
    const huge = batch('1001', 'r1', 400);
    const queued = await enqueueBatch(huge);
    expect(queued.wireError).toBe('batch-exceeds-wire-limits');
    const parsed = JSON.parse(queued.body) as ObservationBatch;
    expect(parsed.routes).toHaveLength(6);
    expect(parsed.routes.every((r) => r.complete === false)).toBe(true);
    expect(parsed.routes[0].body).toEqual({ collectorFailure: 'batch-exceeds-wire-limits' });
  });

  it('retries with byte-identical bodies so the signature stays valid', async () => {
    const { fake, store, transport } = await linked({ failNext: 1 });
    await enqueueBatch(batch('1001', 'r1'));
    await flushOutboxNow({ transport, store });
    await db.jarvisOutbox.toCollection().modify({ nextAttemptAt: 0 });
    await flushOutboxNow({ transport, store });

    const posts = fake.calls.filter((c) => c.path === '/school/observations');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toBe(posts[1].body);
    expect(posts[0].envelope!.nonce).not.toBe(posts[1].envelope!.nonce);
    expect(await db.jarvisOutbox.count()).toBe(0);
  });

  it('keeps at most 50 log entries', async () => {
    const { store, transport } = await linked();
    for (let i = 0; i < 55; i += 1) {
      await enqueueBatch(batch(`C${i}`, `r${i}`));
      await flushOutboxNow({ transport, store });
    }
    expect(await db.jarvisLog.count()).toBeLessThanOrEqual(50);
  });
});
