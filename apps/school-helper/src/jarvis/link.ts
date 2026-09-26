/**
 * The Jarvis link service: pairing, the outbox, and the call log.
 *
 * Everything the UI and the background worker touch goes through here, so the
 * wire protocol stays behind `JarvisTransport`.
 */

import { db, getSettings, saveSettings } from '../common/db';
import type { JarvisLogEntry, JarvisSettings } from '../common/types';
import { canonical } from './canonical';
import type { ObservationBatch } from './evidence';
import { GatewayTransport } from './transport';
import type { JarvisTransport, TransportCall, TransportStore } from './transport';
import { flush as flushOutbox, prune } from './outbox';
import type { OutboxEntry } from './outbox';

export const LOG_LIMIT = 50;
/** Consecutive failed flushes before the dashboard shows a warning. */
export const FAILURE_WARNING_THRESHOLD = 3;

export const DEFAULT_JARVIS: JarvisSettings = {
  enabled: false,
  transport: 'gateway',
  baseUrl: 'https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev',
  appId: 'school-helper',
  failureStreak: 0,
  droppedTotal: 0,
};

/** Keys and pairing live in extension-local storage, not in a backup. */
export function keyStore(): TransportStore {
  const area = () => chrome.storage.local;
  return {
    async get<T>(key: string) {
      const result = await area().get(`jarvis:${key}`);
      return (result as Record<string, T>)[`jarvis:${key}`];
    },
    async set(key: string, value: unknown) {
      await area().set({ [`jarvis:${key}`]: value });
    },
    async delete(key: string) {
      await area().remove(`jarvis:${key}`);
    },
  };
}

export async function jarvisSettings(): Promise<JarvisSettings> {
  const settings = await getSettings();
  return { ...DEFAULT_JARVIS, ...(settings.jarvis ?? {}) };
}

export async function patchJarvis(patch: Partial<JarvisSettings>): Promise<JarvisSettings> {
  const current = await jarvisSettings();
  const next = { ...current, ...patch };
  await saveSettings({ jarvis: next });
  return next;
}

export async function log(
  entry: Omit<JarvisLogEntry, 'id' | 'at'> & { at?: number },
): Promise<void> {
  const record: JarvisLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: entry.at ?? Date.now(),
    endpoint: entry.endpoint,
    method: entry.method,
    status: entry.status,
    ok: entry.ok,
    itemCount: entry.itemCount,
    detail: entry.detail,
  };
  await db.jarvisLog.add(record);
  const total = await db.jarvisLog.count();
  if (total > LOG_LIMIT) {
    const stale = await db.jarvisLog
      .orderBy('at')
      .limit(total - LOG_LIMIT)
      .primaryKeys();
    await db.jarvisLog.bulkDelete(stale);
  }
}

export async function readLog(): Promise<JarvisLogEntry[]> {
  return (await db.jarvisLog
    .orderBy('at')
    .reverse()
    .limit(LOG_LIMIT)
    .toArray()) as JarvisLogEntry[];
}

export interface LinkOptions {
  transport?: JarvisTransport;
  store?: TransportStore;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

export async function makeTransport(options: LinkOptions = {}): Promise<JarvisTransport> {
  if (options.transport) return options.transport;
  const settings = await jarvisSettings();
  const store = options.store ?? keyStore();
  return new GatewayTransport({
    store,
    baseUrl: settings.baseUrl,
    fetchImpl: options.fetchImpl,
    clock: options.clock,
    onCall: (call: TransportCall) => {
      void log({
        endpoint: call.path,
        method: call.method,
        status: call.status,
        ok: call.ok,
        itemCount: 0,
        detail: call.detail,
      });
    },
  });
}

/* ── Pairing ─────────────────────────────────────────────────────────────── */

export async function startPairing(deviceLabel: string, options: LinkOptions = {}) {
  const store = options.store ?? keyStore();
  const transport = await makeTransport(options);
  const result = await transport.startPairing(deviceLabel);
  await store.set('pairing', { ...result, status: 'pending', proved: false, deviceLabel });
  await patchJarvis({
    pairing: {
      status: 'pending',
      collectorId: result.collectorId,
      principalId: result.principalId,
      code: result.code,
      expiresAt: result.expiresAt,
      proved: false,
      deviceLabel,
    },
  });
  // A lost proof response is ambiguous: keep the key and code so a later check
  // can retry the single-use proof or observe an already-approved key.
  await transport.provePairing().then(
    async () => {
      const current = await store.get<Record<string, unknown>>('pairing');
      await store.set('pairing', { ...current, proved: true });
    },
    () => undefined,
  );
  return result;
}

export async function checkPairing(options: LinkOptions = {}) {
  const store = options.store ?? keyStore();
  const transport = await makeTransport(options);
  const identity = await store.get<Record<string, unknown>>('pairing');
  if (!identity) {
    await patchJarvis({ pairing: { status: 'unpaired' } });
    return { status: 'unpaired' as const };
  }
  try {
    const result = await transport.pairingStatus();
    await store.set('pairing', { ...identity, status: result.status });
    await patchJarvis({
      pairing: {
        status: result.status,
        collectorId: identity.collectorId as string,
        principalId: identity.principalId as string,
        code: identity.code as string,
        expiresAt: identity.expiresAt as string,
        proved: identity.proved as boolean,
        deviceLabel: identity.deviceLabel as string,
      },
    });
    return result;
  } catch (error) {
    await patchJarvis({
      pairing: { status: 'unavailable-or-refused', deviceLabel: identity.deviceLabel as string },
    });
    throw error;
  }
}

/* ── Outbox ──────────────────────────────────────────────────────────────── */

/**
 * Canonicalizes a batch and queues it.
 *
 * A batch that will not fit the wire becomes an explicit compact failure, never
 * a truncated success: a truncated course would read to Jarvis as "these are
 * all the assignments", which is exactly the kind of quiet wrong answer this
 * codebase refuses to produce.
 */
export async function enqueueBatch(
  batch: ObservationBatch,
  clock: () => number = Date.now,
): Promise<OutboxEntry> {
  let body: string;
  let wireError: string | undefined;
  try {
    if (batch.routes.length > 256) throw new Error('batch-route-limit');
    body = canonical(batch);
  } catch {
    wireError = 'batch-exceeds-wire-limits';
    const compact = {
      ...batch,
      routes: batch.routes.slice(0, 6).map((route) => ({
        ...route,
        status: 0,
        complete: false,
        body: { collectorFailure: 'batch-exceeds-wire-limits' },
      })),
    };
    body = canonical(compact);
  }
  const entry: OutboxEntry = {
    id: `${batch.host}:${batch.course?.id ?? 'host-failure'}:${batch.readId}`,
    body,
    host: batch.host,
    courseId: batch.course?.id ?? 'host-failure',
    readId: batch.readId,
    itemCount: batch.routes.length,
    createdAt: clock(),
    attempts: 0,
    nextAttemptAt: 0,
    wireError,
  };
  await db.jarvisOutbox.put(entry);
  return entry;
}

export interface FlushOutcome {
  sent: number;
  failed: number;
  queued: number;
  evicted: number;
  error: string | null;
  warn: boolean;
}

export async function flushOutboxNow(
  options: LinkOptions & { sendPending?: boolean } = {},
): Promise<FlushOutcome> {
  const settings = await jarvisSettings();
  const clock = options.clock ?? Date.now;
  const entries = (await db.jarvisOutbox.orderBy('createdAt').toArray()) as OutboxEntry[];

  if (!settings.enabled) {
    // Still bound the queue while the link is off, so turning it off during an
    // outage cannot let storage grow without limit.
    const { queue, evicted } = prune(entries);
    await commit(queue, entries);
    if (evicted) await recordDrops(evicted, settings);
    return {
      sent: 0,
      failed: 0,
      queued: queue.length,
      evicted,
      error: 'link-disabled',
      warn: false,
    };
  }

  const transport = await makeTransport(options);
  const store = options.store ?? keyStore();
  const pairing = await store.get<{ status?: string }>('pairing');

  const result = await flushOutbox(entries, {
    clock,
    sendPending: options.sendPending ?? true,
    paired: pairing?.status === 'active',
    send: async (entry) => transport.sendObservation(entry.body),
  });

  await commit(result.queue, entries);
  if (result.evicted) await recordDrops(result.evicted, settings);

  const streak = result.failed > 0 ? settings.failureStreak + 1 : 0;
  await patchJarvis({ failureStreak: streak });

  await log({
    endpoint: '/school/observations',
    method: 'POST',
    status: result.failed ? 0 : 200,
    ok: result.failed === 0,
    itemCount: result.sent,
    detail: result.error ?? `sent ${result.sent}`,
  });

  return {
    sent: result.sent,
    failed: result.failed,
    queued: result.queue.length,
    evicted: result.evicted,
    error: result.error,
    warn: streak >= FAILURE_WARNING_THRESHOLD,
  };
}

async function commit(queue: OutboxEntry[], previous: OutboxEntry[]): Promise<void> {
  const keep = new Set(queue.map((e) => e.id));
  const remove = previous.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (remove.length) await db.jarvisOutbox.bulkDelete(remove);
  if (queue.length) await db.jarvisOutbox.bulkPut(queue);
}

async function recordDrops(evicted: number, settings: JarvisSettings): Promise<void> {
  await patchJarvis({ droppedTotal: settings.droppedTotal + evicted });
  await log({
    endpoint: 'outbox',
    method: 'EVICT',
    status: 0,
    ok: false,
    itemCount: evicted,
    detail: `queue-evicted-${evicted}`,
  });
}

export async function outboxDepth(): Promise<number> {
  return db.jarvisOutbox.count();
}

/** Dashboard warning text, or null when there is nothing to warn about. */
export async function linkWarning(): Promise<string | null> {
  const settings = await jarvisSettings();
  if (!settings.enabled) return null;
  const queued = await outboxDepth();
  if (settings.failureStreak >= FAILURE_WARNING_THRESHOLD) {
    return `Jarvis link has failed ${settings.failureStreak} times in a row. ${queued} batch${queued === 1 ? '' : 'es'} still queued.`;
  }
  if (settings.droppedTotal > 0) {
    return `Jarvis link has dropped ${settings.droppedTotal} queued batch${settings.droppedTotal === 1 ? '' : 'es'} to stay within its storage cap.`;
  }
  return null;
}
