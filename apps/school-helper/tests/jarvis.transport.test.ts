import { describe, expect, it } from 'vitest';
import { GatewayTransport, TransportError } from '../src/jarvis/transport';
import { canonical } from '../src/jarvis/canonical';
import { FakeJarvis, memoryStore } from './fake-jarvis';
import type { FakeOptions } from './fake-jarvis';

/** Pairs a transport against the fake and returns both. */
async function paired(options: FakeOptions = {}) {
  const fake = new FakeJarvis(options);
  const store = memoryStore();
  const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
  const start = await transport.startPairing('Home PC');
  await store.set('pairing', { ...start, status: 'pending' });
  await transport.provePairing();
  fake.approve();
  await transport.pairingStatus();
  await store.set('pairing', { ...start, status: 'active' });
  return { fake, store, transport };
}

describe('Jarvis gateway transport — pairing', () => {
  it('starts pairing, returns a code, and keeps the private key non-extractable', async () => {
    const fake = new FakeJarvis();
    const store = memoryStore();
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    const start = await transport.startPairing('Home PC');

    expect(start.code).toBe('481-902');
    expect(start.collectorId).toBe('collector-1');
    const keys = await store.get<CryptoKeyPair>('keys');
    expect(keys?.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', keys!.privateKey)).rejects.toThrow();
  });

  it('persists the key BEFORE the first outbound proof', async () => {
    // A service-worker death between generate and store would strand an
    // approved public key whose private half is gone.
    const fake = new FakeJarvis();
    const store = memoryStore();
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    const seen: string[] = [];
    const originalSet = store.set.bind(store);
    store.set = async (key, value) => {
      seen.push(`set:${key}`);
      return originalSet(key, value);
    };
    const wrapped = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    await wrapped.startPairing('Home PC');
    expect(seen[0]).toBe('set:keys');
    void transport;
  });

  it('refuses an empty, over-long or control-character device label', async () => {
    const fake = new FakeJarvis();
    const transport = new GatewayTransport({ store: memoryStore(), fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    await expect(transport.startPairing('')).rejects.toThrow('invalid-device-label');
    await expect(transport.startPairing('x'.repeat(65))).rejects.toThrow('invalid-device-label');
    await expect(transport.startPairing('Home\u0000PC')).rejects.toThrow('invalid-device-label');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports pending until the owner approves, then active', async () => {
    const fake = new FakeJarvis();
    const store = memoryStore();
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    const start = await transport.startPairing('Home PC');
    await store.set('pairing', { ...start, status: 'pending' });
    await transport.provePairing();

    expect((await transport.pairingStatus()).status).toBe('pending');
    fake.approve();
    expect((await transport.pairingStatus()).status).toBe('active');
  });

  it('rejects a pairing response missing required fields', async () => {
    const store = memoryStore();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ collectorId: 'c' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const transport = new GatewayTransport({ store, fetchImpl, baseUrl: 'https://gateway.test' });
    await expect(transport.startPairing('Home PC')).rejects.toThrow('invalid-pairing-response');
  });
});

describe('Jarvis gateway transport — auth', () => {
  it('signs every call after start, and the gateway verifies it', async () => {
    const { fake } = await paired();
    const signed = fake.calls.filter((c) => c.path !== '/school/pairing/start');
    expect(signed.length).toBeGreaterThan(0);
    expect(signed.every((c) => c.envelope?.signatureBase64)).toBe(true);
    expect(signed.every((c) => c.envelope?.audience === 'jarvis-school-collector')).toBe(true);
  });

  it('AUTH FAILURE: a tampered body is refused by the receiver', async () => {
    const { fake, store } = await paired({ autoApprove: true });
    const transport = new GatewayTransport({
      store,
      baseUrl: 'https://gateway.test',
      // Sign the real body, then post a different one.
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
        fake.fetch(input, { ...init, body: `${String(init?.body)} ` })) as typeof fetch,
    });
    await expect(transport.sendObservation(canonical({ a: 1 }))).rejects.toThrow('gateway-refused-401');
  });

  it('AUTH FAILURE: observations before owner approval are refused with 403', async () => {
    const fake = new FakeJarvis();
    const store = memoryStore();
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    const start = await transport.startPairing('Home PC');
    await store.set('pairing', { ...start, status: 'pending' });
    await transport.provePairing();
    await expect(transport.sendObservation(canonical({ a: 1 }))).rejects.toThrow('gateway-refused-403');
  });

  it('uses a fresh nonce per attempt so a retry is not replay-refused', async () => {
    const { fake, store } = await paired({ autoApprove: true });
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    const body = canonical({ schemaVersion: '1.0', n: 1 });
    await transport.sendObservation(body);
    await transport.sendObservation(body); // identical bytes, must still be accepted
    const nonces = fake.calls.filter((c) => c.path === '/school/observations').map((c) => c.envelope?.nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('sends ambient credentials omitted and refuses redirects', async () => {
    const { fake, transport } = await paired({ autoApprove: true });
    // The fake rejects any call that does not omit credentials, so reaching
    // this point at all proves the client omitted them.
    expect(fake.calls.length).toBeGreaterThan(0);
    fake.options.redirect = true;
    await expect(transport.sendObservation(canonical({ a: 1 }))).rejects.toThrow('gateway-redirect-refused');
  });
});

describe('Jarvis gateway transport — failure modes', () => {
  it('surfaces a 500 as an error rather than a silent success', async () => {
    const { fake, transport } = await paired({ autoApprove: true });
    fake.options.failObservationsWith = 500;
    await expect(transport.sendObservation(canonical({ a: 1 }))).rejects.toThrow('gateway-refused-500');
  });

  it('TIMEOUT: an unresponsive gateway aborts and reports a timeout', async () => {
    const { store } = await paired({ autoApprove: true });
    const transport = new GatewayTransport({
      store,
      baseUrl: 'https://gateway.test',
      timeoutMs: 50,
      fetchImpl: (async (_i: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
        })) as typeof fetch,
    });
    const promise = transport.sendObservation(canonical({ a: 1 }));
    await expect(promise).rejects.toThrow('gateway-timeout');
  });

  it('rejects a malformed receipt instead of treating it as delivered', async () => {
    const { fake, transport } = await paired({ autoApprove: true });
    fake.options.badReceipt = true;
    await expect(transport.sendObservation(canonical({ a: 1 }))).rejects.toThrow('invalid-receipt');
  });

  it('refuses to POST anywhere outside the four allowed paths', async () => {
    const { fake, store } = await paired({ autoApprove: true });
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    const post = (transport as unknown as { post: (p: string, b: string) => Promise<unknown> }).post.bind(transport);
    await expect(post('/school/anything-else', '{}')).rejects.toBeInstanceOf(TransportError);
    expect(fake.calls.every((c) => c.path.startsWith('/school/'))).toBe(true);
  });

  it('refuses a body at or over the 64 KiB receiver cap', async () => {
    const { fake, store } = await paired({ autoApprove: true });
    const transport = new GatewayTransport({ store, fetchImpl: fake.fetch, baseUrl: 'https://gateway.test' });
    await expect(transport.sendObservation('x'.repeat(70000))).rejects.toThrow('batch-too-large');
  });

  it('reports the gateway origin it needs host permission for', async () => {
    const transport = new GatewayTransport({ store: memoryStore(), baseUrl: 'https://gateway.test' });
    expect(transport.origins()).toEqual(['https://gateway.test/*']);
  });
});
