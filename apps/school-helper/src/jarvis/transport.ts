/**
 * The one seam between School Helper and Jarvis.
 *
 * Every byte that leaves for Jarvis goes through a `JarvisTransport`. There is
 * exactly one implementation today — `GatewayTransport`, the real signed
 * protocol the deployed cloud-gateway speaks. The interface exists so a second
 * contract can be added later without touching the outbox, the link service,
 * the background worker or the UI.
 *
 * Pull lives here too: `pullRequests` asks the gateway what Jarvis wants
 * (POST /school/pull, signed). The extension can only be reached this way —
 * MV3 ended push — so Jarvis queues sync_now/open_item requests and the
 * background alarm collects them.
 */

import { canonical } from './canonical';
import { GATEWAY, PATHS, REQUEST_TIMEOUT_MS, createKey, publicKeyBase64, sign } from './envelope';
import type { DeviceIdentity, JarvisPath, SignedEnvelope } from './envelope';

export interface PairingStart {
  collectorId: string;
  principalId: string;
  challenge: string;
  /** Shown in the UI so Sid can match it to Jarvis's Telegram approval. */
  code: string;
  expiresAt: string;
}

export interface PairingStatusResult {
  status: 'pending' | 'active';
}

export interface ObservationReceipt {
  batchId: string;
  outcome: 'good' | 'failed';
}

export interface PulledRequest {
  requestId: string;
  action: string;
  args: unknown;
}

export interface TransportCall {
  path: string;
  method: string;
  status: number;
  ok: boolean;
  detail?: string;
}

/** Storage the transport needs. Keys are live CryptoKeys, never bytes. */
export interface TransportStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface JarvisTransport {
  readonly kind: string;
  /** Origins the extension must hold host permission for. */
  origins(): string[];
  startPairing(deviceLabel: string): Promise<PairingStart>;
  provePairing(): Promise<void>;
  pairingStatus(): Promise<PairingStatusResult>;
  /** Sends one already-canonicalized body. Must not re-serialize it. */
  sendObservation(body: string): Promise<ObservationReceipt>;
  /** Pulls Jarvis's queued requests (sync_now, open_item). Empty when none. */
  pullRequests(): Promise<PulledRequest[]>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface GatewayOptions {
  store: TransportStore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  cryptoImpl?: Crypto;
  clock?: () => number;
  /** Overrides the 15s request timeout. Tests use a short one. */
  timeoutMs?: number;
  /** Called for every completed call so the UI log can show exactly what went out. */
  onCall?: (call: TransportCall) => void;
}

export class GatewayTransport implements JarvisTransport {
  readonly kind = 'gateway';
  private readonly store: TransportStore;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cryptoImpl: Crypto;
  private readonly clock: () => number;
  private readonly onCall?: (call: TransportCall) => void;
  private readonly timeoutMs: number;

  constructor(options: GatewayOptions) {
    this.store = options.store;
    this.base = (options.baseUrl ?? GATEWAY).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.cryptoImpl = options.cryptoImpl ?? crypto;
    this.clock = options.clock ?? Date.now;
    this.onCall = options.onCall;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  origins(): string[] {
    return [`${new URL(this.base).origin}/*`];
  }

  /** POST with ambient credentials omitted and redirects refused, always. */
  private async post(path: JarvisPath, body: string, envelope?: SignedEnvelope): Promise<unknown> {
    if (!(PATHS as readonly string[]).includes(path))
      throw new TransportError('invalid-gateway-path');
    if (new TextEncoder().encode(body).length >= 65536) throw new TransportError('batch-too-large');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(envelope ? { 'x-jarvis-signed-request': JSON.stringify(envelope) } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail =
        (error as Error)?.name === 'TimeoutError' ? 'gateway-timeout' : 'gateway-unreachable';
      this.onCall?.({ path, method: 'POST', status: 0, ok: false, detail });
      throw new TransportError(detail);
    }
    if (
      response.status === 0 ||
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      this.onCall?.({
        path,
        method: 'POST',
        status: response.status,
        ok: false,
        detail: 'gateway-redirect-refused',
      });
      throw new TransportError('gateway-redirect-refused', response.status);
    }
    if (!response.ok) {
      this.onCall?.({
        path,
        method: 'POST',
        status: response.status,
        ok: false,
        detail: `gateway-refused-${response.status}`,
      });
      throw new TransportError(`gateway-refused-${response.status}`, response.status);
    }
    this.onCall?.({ path, method: 'POST', status: response.status, ok: true });
    return response.json();
  }

  private async signedPost(path: JarvisPath, body: string): Promise<unknown> {
    const identity = await this.store.get<DeviceIdentity>('pairing');
    const keys = await this.store.get<CryptoKeyPair>('keys');
    if (!identity || !keys) throw new TransportError('pairing-required');
    const envelope = await sign(path, body, keys, identity, this.clock(), this.cryptoImpl);
    return this.post(path, body, envelope);
  }

  async startPairing(deviceLabel: string): Promise<PairingStart> {
    if (
      typeof deviceLabel !== 'string' ||
      !deviceLabel.trim() ||
      deviceLabel.length > 64 ||
      /\p{C}/u.test(deviceLabel)
    ) {
      throw new TransportError('invalid-device-label');
    }
    const keys = await createKey(this.cryptoImpl);
    // Persist before any outbound proof: a worker restart must never leave an
    // approved public key whose private half died in memory.
    await this.store.set('keys', keys);
    const result = (await this.post(
      '/school/pairing/start',
      canonical({ publicKeyBase64: await publicKeyBase64(keys, this.cryptoImpl), deviceLabel }),
    )) as PairingStart;
    const required: (keyof PairingStart)[] = [
      'collectorId',
      'principalId',
      'challenge',
      'code',
      'expiresAt',
    ];
    if (!required.every((key) => typeof result?.[key] === 'string' && result[key])) {
      throw new TransportError('invalid-pairing-response');
    }
    return result;
  }

  async provePairing(): Promise<void> {
    const identity = await this.store.get<{ challenge: string }>('pairing');
    if (!identity?.challenge) throw new TransportError('pairing-required');
    await this.signedPost('/school/pairing/prove', canonical({ challenge: identity.challenge }));
  }

  async pairingStatus(): Promise<PairingStatusResult> {
    const result = (await this.signedPost('/school/pairing/status', '{}')) as PairingStatusResult;
    if (!['pending', 'active'].includes(result?.status))
      throw new TransportError('invalid-pairing-status');
    return result;
  }

  async sendObservation(body: string): Promise<ObservationReceipt> {
    const receipt = (await this.signedPost('/school/observations', body)) as ObservationReceipt;
    if (!receipt?.batchId || !['good', 'failed'].includes(receipt.outcome)) {
      throw new TransportError('invalid-receipt');
    }
    return receipt;
  }

  async pullRequests(): Promise<PulledRequest[]> {
    const result = (await this.signedPost('/school/pull', '{}')) as { requests?: unknown };
    if (!result || !Array.isArray(result.requests)) throw new TransportError('invalid-pull-response');
    const out: PulledRequest[] = [];
    for (const entry of result.requests) {
      if (typeof entry !== 'object' || entry === null) throw new TransportError('invalid-pull-response');
      const rec = entry as Record<string, unknown>;
      if (typeof rec.requestId !== 'string' || typeof rec.action !== 'string') {
        throw new TransportError('invalid-pull-response');
      }
      out.push({ requestId: rec.requestId, action: rec.action, args: rec.args ?? null });
    }
    return out;
  }
}
