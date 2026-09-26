/**
 * Runs an evidence read for Jarvis and flushes the outbox.
 *
 * Called after School Helper's own sync. It deliberately does NOT reuse the
 * parsed sync result: Jarvis is sent raw D2L bodies, and deriving them back
 * from WorkItems would smuggle School Helper's interpretation onto the wire.
 *
 * Durham is only ever reached after LDSB, through the cross-board session the
 * LDSB homepage's "My Courses in Other Boards" widget establishes. There is no
 * separate Durham login and none is attempted.
 */

import { collectHost } from './evidence';
import type { EvidenceStore, HostResult } from './evidence';
import { BOARD_HOST } from './routes';
import type { JarvisHost } from './routes';
import { makeReader } from './reader';
import { enqueueBatch, flushOutboxNow, jarvisSettings, log } from './link';
import type { LinkOptions } from './link';

/** LDSB first, always: Durham federation depends on that session existing. */
export const HOST_ORDER: JarvisHost[] = [BOARD_HOST.ldsb, BOARD_HOST.durham];

export interface PushOptions extends LinkOptions {
  readId?: string;
  /** Returns an ISO instant for evidence timestamps. */
  isoClock?: () => string;
  fetchImpl?: typeof fetch;
  evidenceStore?: EvidenceStore;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
  /**
   * Establishes the Durham session via the LDSB "My Courses in Other Boards"
   * hop. Supplied by the background worker, which owns the D2L clients. When
   * omitted, Durham is read with whatever session already exists.
   */
  ensureDurham?: () => Promise<void>;
}

function localStore(): EvidenceStore {
  return {
    async get<T>(key: string) {
      const result = await chrome.storage.local.get(`jarvis-evidence:${key}`);
      return (result as Record<string, T>)[`jarvis-evidence:${key}`];
    },
    async set(key: string, value: unknown) {
      await chrome.storage.local.set({ [`jarvis-evidence:${key}`]: value });
    },
  };
}

export interface PushResult {
  ran: boolean;
  reason?: string;
  hosts: HostResult[];
  sent: number;
  queued: number;
  evicted: number;
  error: string | null;
}

export async function pushEvidence(options: PushOptions = {}): Promise<PushResult> {
  const settings = await jarvisSettings();
  if (!settings.enabled)
    return {
      ran: false,
      reason: 'link-disabled',
      hosts: [],
      sent: 0,
      queued: 0,
      evicted: 0,
      error: null,
    };
  if (settings.pairing?.status !== 'active') {
    return {
      ran: false,
      reason: 'pairing-required',
      hosts: [],
      sent: 0,
      queued: 0,
      evicted: 0,
      error: 'pairing-required',
    };
  }

  const readId = options.readId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = options.evidenceStore ?? localStore();
  const read = makeReader({
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    spacingMs: options.spacingMs,
  });
  const isoClock = options.isoClock ?? (() => new Date().toISOString());
  const hosts: HostResult[] = [];

  for (const host of HOST_ORDER) {
    if (host === BOARD_HOST.durham && options.ensureDurham) {
      // Durham is reached only through the LDSB hop. A failure here is logged
      // and the read still proceeds, so the receiver gets explicit per-route
      // session failures rather than silence.
      try {
        await options.ensureDurham();
      } catch (error) {
        await log({
          endpoint: 'sso',
          method: 'GET',
          status: 0,
          ok: false,
          itemCount: 0,
          detail: (error as Error).message,
        });
      }
    }
    const result = await collectHost({
      host,
      request: read,
      store,
      clock: isoClock,
      readId,
      emit: async (batch) => {
        const entry = await enqueueBatch(batch);
        return { error: entry.wireError ?? null };
      },
    });
    hosts.push(result);
  }

  const flushed = await flushOutboxNow(options);
  return {
    ran: true,
    hosts,
    sent: flushed.sent,
    queued: flushed.queued,
    evicted: flushed.evicted,
    error: flushed.error,
  };
}
