/**
 * A fake Jarvis cloud-gateway.
 *
 * It enforces the parts of the real receiver's contract that our client has to
 * satisfy: the four allowed paths, Ed25519 signature verification over the
 * exact body bytes, single-use nonces, the pairing state machine and the 64 KiB
 * body cap. If the client drifts from the protocol, these tests fail.
 */

import { verify } from '../src/jarvis/envelope';
import type { SignedEnvelope } from '../src/jarvis/envelope';

export interface FakeCall {
  path: string;
  body: string;
  envelope?: SignedEnvelope;
}

export interface FakeOptions {
  /** Approve pairing immediately instead of waiting for an owner tap. */
  autoApprove?: boolean;
  /** Force every observation POST to this status. */
  failObservationsWith?: number;
  /** Make the next N observation POSTs fail, then recover. */
  failNext?: number;
  /** Never resolve, so the client's timeout fires. */
  hang?: boolean;
  /** Return a 3xx so the client's redirect refusal triggers. */
  redirect?: boolean;
  /** Return a receipt the client should reject. */
  badReceipt?: boolean;
}

export class FakeJarvis {
  readonly calls: FakeCall[] = [];
  readonly batches: unknown[] = [];
  private publicKey?: CryptoKey;
  private challenge = 'challenge-abc';
  private approved = false;
  pullRequests: { requestId: string; action: string; args: unknown }[] = [];
  private proved = false;
  private readonly nonces = new Set<string>();
  private remainingFailures: number;

  constructor(readonly options: FakeOptions = {}) {
    this.approved = options.autoApprove ?? false;
    this.remainingFailures = options.failNext ?? 0;
  }

  /** Simulates Sid approving the pairing code in Telegram. */
  approve(): void {
    this.approved = true;
  }

  get provedOnce(): boolean {
    return this.proved;
  }

  get fetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const path = url.pathname;
      const body = String(init?.body ?? '');
      const raw = (init?.headers as Record<string, string> | undefined)?.['x-jarvis-signed-request'];
      const envelope = raw ? (JSON.parse(raw) as SignedEnvelope) : undefined;
      this.calls.push({ path, body, envelope });

      if (this.options.hang) await new Promise(() => {});

      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

      if (init?.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
      if (init?.credentials !== 'omit') return json({ error: 'credentials-must-be-omitted' }, 400);
      if (new TextEncoder().encode(body).length >= 65536) return json({ error: 'school_batch_too_large' }, 413);

      if (this.options.redirect) return new Response('', { status: 302, headers: { location: '/elsewhere' } });

      if (path === '/school/pairing/start') {
        const parsed = JSON.parse(body) as { publicKeyBase64?: string; deviceLabel?: string };
        if (!parsed.publicKeyBase64 || !parsed.deviceLabel) return json({ error: 'school_device_label_invalid' }, 400);
        const bytes = Uint8Array.from(atob(parsed.publicKeyBase64), (c) => c.charCodeAt(0));
        const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength));
        buf.set(bytes);
        this.publicKey = await crypto.subtle.importKey('raw', buf, 'Ed25519', false, ['verify']);
        return json({
          collectorId: 'collector-1',
          principalId: 'principal-1',
          challenge: this.challenge,
          code: '481-902',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }

      // Every other path must carry a valid, unique signature.
      if (!envelope || !this.publicKey) return json({ error: 'school_signature_invalid' }, 401);
      if (envelope.audience !== 'jarvis-school-collector') return json({ error: 'school_authority_invalid' }, 401);
      if (this.nonces.has(envelope.nonce)) return json({ error: 'school_nonce_refused' }, 401);
      this.nonces.add(envelope.nonce);
      if (!(await verify(path, body, envelope, this.publicKey))) {
        return json({ error: 'school_body_hash_invalid' }, 401);
      }

      if (path === '/school/pairing/prove') {
        if (this.proved) return json({ error: 'school_challenge_consumed' }, 409);
        const parsed = JSON.parse(body) as { challenge?: string };
        if (parsed.challenge !== this.challenge) return json({ error: 'school_challenge_invalid' }, 401);
        this.proved = true;
        return json({ ok: true });
      }

      if (path === '/school/pairing/status') {
        return json({ status: this.approved && this.proved ? 'active' : 'pending' });
      }

      if (path === '/school/pull') {
        if (!this.approved) return json({ error: 'school_key_inactive' }, 403);
        return json({ requests: this.pullRequests });
      }

      if (path === '/school/observations') {
        if (!this.approved) return json({ error: 'school_key_inactive' }, 403);
        if (this.options.failObservationsWith) {
          return json({ error: 'school_observation_write_contended' }, this.options.failObservationsWith);
        }
        if (this.remainingFailures > 0) {
          this.remainingFailures -= 1;
          return json({ error: 'school_observation_write_contended' }, 500);
        }
        if (this.options.badReceipt) return json({ batchId: '', outcome: 'maybe' });
        this.batches.push(JSON.parse(body));
        return json({ batchId: `batch-${this.batches.length}`, outcome: 'good' });
      }

      return json({ error: 'school_route_invalid' }, 404);
    }) as typeof fetch;
  }
}

/** In-memory TransportStore. */
export function memoryStore() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}
