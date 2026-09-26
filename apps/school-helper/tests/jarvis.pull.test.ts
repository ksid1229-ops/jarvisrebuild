import { describe, expect, it } from 'vitest';
import { pullAndExecute, type PullDeps } from '../src/jarvis/pull';
import type { JarvisTransport } from '../src/jarvis/transport';

function deps(
  over: Partial<PullDeps> & { queue?: { requestId: string; action: string; args: unknown }[] },
): PullDeps & {
  synced: string[];
  opened: string[];
  logs: { endpoint: string; ok: boolean; detail?: string }[];
} {
  const synced: string[] = [];
  const opened: string[] = [];
  const logs: { endpoint: string; ok: boolean; detail?: string }[] = [];
  const { queue, ...rest } = over;
  return {
    synced,
    opened,
    logs,
    transport: async () => ({ pullRequests: async () => queue ?? [] }) as JarvisTransport,
    isLinked: async () => true,
    runSync: async () => {
      synced.push('sync');
    },
    openUrl: async (url: string) => {
      opened.push(url);
    },
    allowedOrigins: ['https://ldsb.elearningontario.ca', 'https://durham.elearningontario.ca'],
    log: async (entry) => {
      logs.push(entry);
    },
    ...rest,
  };
}

describe('pull channel executor', () => {
  it('does nothing when the link is off or unpaired', async () => {
    const d = deps({
      isLinked: async () => false,
      queue: [{ requestId: 'a', action: 'sync_now', args: {} }],
    });
    const out = await pullAndExecute(d);
    expect(out).toMatchObject({ pulled: 0, ran: [], error: null });
    expect(d.synced).toEqual([]);
  });

  it('runs sync_now and opens allowed URLs, skipping the rest', async () => {
    const d = deps({
      queue: [
        { requestId: 'a', action: 'sync_now', args: {} },
        { requestId: 'b', action: 'open_item', args: { itemUrl: 'https://ldsb.elearningontario.ca/d2l/x' } },
        { requestId: 'c', action: 'open_item', args: { itemUrl: 'https://evil.example/x' } },
        { requestId: 'd', action: 'mystery', args: {} },
      ],
    });
    const out = await pullAndExecute(d);
    expect(out.pulled).toBe(4);
    expect(out.ran).toEqual(['a', 'b']);
    expect(out.skipped).toEqual(['c', 'd']);
    expect(d.synced).toEqual(['sync']);
    expect(d.opened).toEqual(['https://ldsb.elearningontario.ca/d2l/x']);
  });

  it('surfaces a transport failure as an error, not a throw', async () => {
    const d = deps({
      transport: async () => {
        throw new Error('gateway-unreachable');
      },
    });
    const out = await pullAndExecute(d);
    expect(out.error).toBe('gateway-unreachable');
  });
});
