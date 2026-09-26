import { beforeEach, describe, expect, it } from 'vitest';
import { db, saveSettings } from '../src/common/db';
import { makeReader } from '../src/jarvis/reader';
import { HOST_ORDER, pushEvidence } from '../src/jarvis/push';
import { BOARD_HOST } from '../src/jarvis/routes';
import { GatewayTransport } from '../src/jarvis/transport';
import { FakeJarvis, memoryStore } from './fake-jarvis';

const VERSIONS = [
  { ProductCode: 'lp', SupportedVersions: ['1.43'] },
  { ProductCode: 'le', SupportedVersions: ['1.82'] },
];

interface RecordedRequest {
  url: string;
  method: string;
  credentials?: string;
  redirect?: string;
}

function fakeD2l(recorded: RecordedRequest[], overrides: Record<string, () => Response> = {}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    recorded.push({ url, method: String(init?.method), credentials: String(init?.credentials), redirect: String(init?.redirect) });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    for (const [needle, make] of Object.entries(overrides)) if (url.includes(needle)) return make();
    if (url.includes('/versions/')) return json(VERSIONS);
    if (url.includes('myenrollments')) {
      return json({
        Items: [{ Access: { CanAccess: true, IsActive: true }, OrgUnit: { Id: 1001, Name: 'BBB4M0-01', Type: { Id: 3 } } }],
        PagingInfo: { HasMoreItems: false },
      });
    }
    return json([]);
  }) as typeof fetch;
}

async function enableLink() {
  const fake = new FakeJarvis({ autoApprove: true });
  const store = memoryStore();
  const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
  const start = await transport.startPairing('Home PC');
  await store.set('pairing', { ...start, status: 'pending' });
  await transport.provePairing();
  await store.set('pairing', { ...start, status: 'active' });
  await saveSettings({
    jarvis: {
      enabled: true,
      transport: 'gateway',
      baseUrl: 'https://gateway.test',
      appId: 'school-helper',
      failureStreak: 0,
      droppedTotal: 0,
      pairing: { status: 'active' },
    },
  });
  return { fake, store, transport };
}

beforeEach(async () => {
  await Promise.all([db.jarvisOutbox.clear(), db.jarvisLog.clear(), db.settings.clear()]);
});

describe('the D2L reader for Jarvis evidence', () => {
  it('IS GET-ONLY, with credentials included and redirects manual', async () => {
    const recorded: RecordedRequest[] = [];
    const read = makeReader({ fetchImpl: fakeD2l(recorded), spacingMs: 0 });
    await read(BOARD_HOST.ldsb, 'versions');
    await read(BOARD_HOST.ldsb, 'toc', { course: 1001 });
    expect(recorded).toHaveLength(2);
    expect(recorded.every((r) => r.method === 'GET')).toBe(true);
    expect(recorded.every((r) => r.credentials === 'include')).toBe(true);
    expect(recorded.every((r) => r.redirect === 'manual')).toBe(true);
  });

  it('contains no POST, PUT, PATCH or DELETE anywhere in its source contract', async () => {
    const source = await import('node:fs').then((fs) => fs.promises.readFile('src/jarvis/reader.ts', 'utf8'));
    expect(source).not.toMatch(/'POST'|"POST"|'PUT'|'DELETE'|'PATCH'/);
    expect(source).toContain("method: 'GET'");
  });

  it('turns a network error into a failure, not an empty body', async () => {
    const read = makeReader({
      spacingMs: 0,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    const result = await read(BOARD_HOST.ldsb, 'versions');
    expect(result.complete).toBe(false);
    expect(result.body).toEqual({ collectorFailure: 'network-or-timeout' });
  });

  it('refuses an invalid course id instead of building a URL from it', async () => {
    const recorded: RecordedRequest[] = [];
    const read = makeReader({ fetchImpl: fakeD2l(recorded), spacingMs: 0 });
    const result = await read(BOARD_HOST.ldsb, 'toc', { course: '../evil' });
    expect(result.error).toBe('invalid-identifier');
    expect(recorded).toHaveLength(0);
  });
});

describe('pushEvidence', () => {
  it('does nothing at all when the link is off', async () => {
    await saveSettings({
      jarvis: { enabled: false, transport: 'gateway', baseUrl: 'https://gateway.test', appId: 'school-helper', failureStreak: 0, droppedTotal: 0 },
    });
    const recorded: RecordedRequest[] = [];
    const result = await pushEvidence({ fetchImpl: fakeD2l(recorded), spacingMs: 0 });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('link-disabled');
    expect(recorded).toHaveLength(0);
    expect(await db.jarvisOutbox.count()).toBe(0);
  });

  it('refuses to read or send while pairing is not active', async () => {
    await saveSettings({
      jarvis: {
        enabled: true, transport: 'gateway', baseUrl: 'https://gateway.test', appId: 'school-helper',
        failureStreak: 0, droppedTotal: 0, pairing: { status: 'pending' },
      },
    });
    const recorded: RecordedRequest[] = [];
    const result = await pushEvidence({ fetchImpl: fakeD2l(recorded), spacingMs: 0 });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('pairing-required');
    expect(recorded).toHaveLength(0);
  });

  it('reads both boards and delivers one batch per course', async () => {
    const { fake, store, transport } = await enableLink();
    const recorded: RecordedRequest[] = [];
    const result = await pushEvidence({
      fetchImpl: fakeD2l(recorded),
      spacingMs: 0,
      transport,
      store,
      evidenceStore: memoryStore(),
    });
    expect(result.ran).toBe(true);
    expect(result.hosts.map((h) => h.host)).toEqual(HOST_ORDER);
    expect(fake.batches).toHaveLength(2); // one course on each board
    expect(result.sent).toBe(2);
    expect(await db.jarvisOutbox.count()).toBe(0);
  });

  it('DURHAM IS REACHED ONLY AFTER LDSB, via the cross-board hop', async () => {
    const { store, transport } = await enableLink();
    const recorded: RecordedRequest[] = [];
    const order: string[] = [];
    await pushEvidence({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        order.push(new URL(String(input)).hostname);
        return fakeD2l(recorded)(input, init);
      }) as typeof fetch,
      spacingMs: 0,
      transport,
      store,
      evidenceStore: memoryStore(),
      ensureDurham: async () => {
        order.push('SSO-HOP');
      },
    });
    const firstDurham = order.indexOf('durham.elearningontario.ca');
    const lastLdsb = order.lastIndexOf('ldsb.elearningontario.ca');
    const hop = order.indexOf('SSO-HOP');
    expect(firstDurham).toBeGreaterThan(-1);
    expect(hop).toBeGreaterThan(lastLdsb); // hop happens after LDSB is done
    expect(firstDurham).toBeGreaterThan(hop); // and before any Durham read
  });

  it('records a failed SSO hop and still sends explicit per-route failures', async () => {
    const { fake, store, transport } = await enableLink();
    const recorded: RecordedRequest[] = [];
    await pushEvidence({
      fetchImpl: fakeD2l(recorded, {
        'durham.elearningontario.ca': () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      }),
      spacingMs: 0,
      transport,
      store,
      evidenceStore: memoryStore(),
      ensureDurham: async () => {
        throw new Error('sso-failed');
      },
    });
    const log = await db.jarvisLog.toArray();
    expect(log.some((e) => e.endpoint === 'sso' && e.detail === 'sso-failed')).toBe(true);
    // Durham produced an explicit failure rather than silence.
    const durham = fake.batches.filter((b) => (b as { host: string }).host === 'durham.elearningontario.ca');
    expect(durham.length).toBeGreaterThan(0);
  });

  it('a D2L outage queues batches instead of claiming a clean read', async () => {
    const { store, transport } = await enableLink();
    const result = await pushEvidence({
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
      spacingMs: 0,
      transport,
      store,
      evidenceStore: memoryStore(),
    });
    expect(result.hosts.every((h) => h.lastGoodRead === null)).toBe(true);
    expect(result.hosts.every((h) => h.error !== null)).toBe(true);
  });
});
