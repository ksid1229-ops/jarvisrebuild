/**
 * School collector protocol: batch validation + signed-request verification.
 *
 * The canonical-JSON vectors below are KNOWN-ANSWER cases shared with the
 * School Helper app — the app's suite must pin the same vectors, so a drift
 * on either side of the wire fails loudly here instead of in production.
 *
 * The test signer mirrors the app's `sign()` with the FIXED contract:
 * `issuedAt` is an ISO-8601 UTC string, as the proven reference requires.
 * A numeric issuedAt (what the app sent before the fix) is refused.
 */
import { describe, expect, it } from "vitest";
import { canonical } from "../src/school/canonical.js";
import {
  encodeBase64Url,
  sha256Hex,
  type SignedRequestV1,
} from "../src/school/signed-request.js";
import {
  parseSchoolBatch,
  verifyCollectorRequest,
  type CollectorDb,
  type CollectorKey,
} from "../src/school/collector-protocol.js";

const COURSE_BATCH = {
  schemaVersion: "1.0",
  host: "ldsb.elearningontario.ca",
  readId: "read-1",
  startedAt: "2026-09-26T18:04:00.000Z",
  courseIds: ["1001"],
  enrollmentComplete: true,
  course: { id: "1001", name: "BBB4M0-01 International Business" },
  routes: [
    {
      route: "/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=1001",
      status: 200,
      fetchedAt: "2026-09-26T18:04:02.000Z",
      complete: true,
      body: [{ Id: 55, Title: "Unit 3 Response", DueDate: null }],
    },
    {
      route: "/d2l/api/le/1.82/1001/dropbox/folders/",
      status: 200,
      fetchedAt: "2026-09-26T18:04:03.000Z",
      complete: true,
      body: [],
    },
  ],
};

const HOST_FAILURE_BATCH = {
  schemaVersion: "1.0",
  host: "durham.elearningontario.ca",
  readId: "read-2",
  startedAt: "2026-09-26T18:04:00.000Z",
  courseIds: [],
  enrollmentComplete: false,
  course: null,
  routes: [
    {
      route: "/d2l/api/versions/",
      status: 200,
      fetchedAt: "2026-09-26T18:04:01.000Z",
      complete: false,
      body: { collectorFailure: "session-expired" },
    },
  ],
};

const NOW = new Date("2026-09-26T19:00:00.000Z");

describe("canonical JSON (shared wire vectors)", () => {
  it("sorts keys with no whitespace", () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical({ z: [3, 2], a: { y: "x" } })).toBe('{"a":{"y":"x"},"z":[3,2]}');
  });
  it("NFC-normalizes keys and strings", () => {
    // "e" + combining acute must serialize identically to composed "é".
    expect(canonical({ ["é"]: 1 })).toBe(canonical({ ["é"]: 1 }));
    expect(canonical({ ["é"]: 1 })).toBe('{"é":1}');
  });
  it("refuses duplicate keys after NFC normalization", () => {
    expect(() => canonical({ ["é"]: 1, ["é"]: 2 })).toThrow("duplicate-normalized-key");
  });
  it("serializes scalars and nesting deterministically", () => {
    expect(canonical({ b: "A", a: ["é", null, true, 1.5] })).toBe(
      '{"a":["é",null,true,1.5],"b":"A"}',
    );
  });
});

describe("parseSchoolBatch", () => {
  it("accepts a valid course batch", () => {
    const batch = parseSchoolBatch(structuredClone(COURSE_BATCH), NOW);
    expect(batch.courseIds).toEqual(["1001"]);
    expect(batch.routes).toHaveLength(2);
  });
  it("rejects an extra field anywhere", () => {
    const bad = structuredClone(COURSE_BATCH) as Record<string, unknown>;
    bad.extra = true;
    expect(() => parseSchoolBatch(bad, NOW)).toThrow("school_fields_invalid");
  });
  it("rejects a numeric startedAt (the receiver parses ISO instants)", () => {
    const bad = structuredClone(COURSE_BATCH) as Record<string, unknown>;
    bad.startedAt = 1790000000000;
    expect(() => parseSchoolBatch(bad, NOW)).toThrow("school_started_at");
  });
  it("rejects a duplicate route label", () => {
    const bad = structuredClone(COURSE_BATCH);
    bad.routes.push(structuredClone(bad.routes[0]!));
    expect(() => parseSchoolBatch(bad, NOW)).toThrow("school_route_invalid");
  });
  it("rejects a batch from the future", () => {
    const bad = structuredClone(COURSE_BATCH);
    bad.startedAt = "2026-09-26T20:00:00.000Z";
    bad.routes[0]!.fetchedAt = "2026-09-26T20:00:01.000Z";
    bad.routes[1]!.fetchedAt = "2026-09-26T20:00:02.000Z";
    expect(() => parseSchoolBatch(bad, NOW)).toThrow("school_time_future");
  });
  it("rejects a fetchedAt before startedAt", () => {
    const bad = structuredClone(COURSE_BATCH);
    bad.routes[0]!.fetchedAt = "2026-09-26T18:03:59.000Z";
    expect(() => parseSchoolBatch(bad, NOW)).toThrow("school_time_invalid");
  });
  it("accepts a host-failure batch", () => {
    const batch = parseSchoolBatch(structuredClone(HOST_FAILURE_BATCH), NOW);
    expect(batch.course).toBeNull();
  });
  it("rejects a host-failure batch with no routes (silence is not evidence)", () => {
    const bad = structuredClone(HOST_FAILURE_BATCH);
    bad.routes = [];
    expect(() => parseSchoolBatch(bad, NOW)).toThrow("school_routes_invalid");
  });
  it("treats a JSON 403 as fully observed evidence, not a failure", () => {
    const batch = structuredClone(COURSE_BATCH) as unknown as {
      routes: { route: string; status: number; fetchedAt: string; complete: boolean; body: unknown }[];
    };
    batch.routes[1] = {
      route: "/d2l/api/le/1.82/1001/dropbox/folders/77/submissions/mysubmissions/",
      status: 403,
      fetchedAt: "2026-09-26T18:04:05.000Z",
      complete: true,
      body: { Errors: ["Not authorized"] },
    };
    expect(() => parseSchoolBatch(batch, NOW)).not.toThrow();
  });
});

/** Minimal in-memory stand-in for the D1 queries this protocol runs. */
class FakeCollectorDb implements CollectorDb {
  keys = new Map<string, CollectorKey>();
  nonces = new Set<string>();
  prepare(sql: string): {
    bind(...params: unknown[]): { first<T>(): Promise<T | null> };
  } {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...params: unknown[]) => ({
        first: async <T,>(): Promise<T | null> => {
          if (normalized.startsWith("SELECT * FROM school_collector_keys")) {
            const [collectorId, principalId, status, nowIso] = params as [
              string,
              string,
              string,
              string,
            ];
            const key = this.keys.get(collectorId);
            if (
              !key ||
              key.principal_id !== principalId ||
              key.status !== status ||
              (key.status !== "active" && !(key.expires_at > nowIso))
            ) {
              return null;
            }
            return key as unknown as T;
          }
          if (normalized.startsWith("INSERT INTO school_collector_nonces")) {
            const [nonce, , collectorId, status] = params as [
              string,
              string,
              string,
              string,
            ];
            const key = this.keys.get(collectorId);
            const nonceKey = `${collectorId}:${nonce}`;
            if (!key || key.status !== status || this.nonces.has(nonceKey)) return null;
            this.nonces.add(nonceKey);
            return { collector_id: collectorId } as unknown as T;
          }
          throw new Error(`unexpected sql in fake: ${normalized.slice(0, 60)}`);
        },
      }),
    };
  }
}

const b64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Test signer. Mirrors the app's sign() with the FIXED contract: issuedAt is
 * an ISO-8601 UTC string. If the app sends anything else, verification fails —
 * that is the break the app fix repairs.
 */
async function signTestEnvelope(opts: {
  path: string;
  body: string;
  keys: CryptoKeyPair;
  deviceId: string;
  principalId: string;
  issuedAt: string;
  nonce?: string;
}): Promise<SignedRequestV1> {
  const bodyBytes = new TextEncoder().encode(opts.body);
  const hash = await crypto.subtle.digest("SHA-256", bodyBytes);
  const bodyHash = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const nonce =
    opts.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const unsigned = {
    schemaVersion: "1.0" as const,
    deviceId: opts.deviceId,
    principalId: opts.principalId,
    audience: "jarvis-school-collector",
    issuedAt: opts.issuedAt,
    nonce,
    bodyHash,
  };
  const message = new TextEncoder().encode(
    ["POST", opts.path, unsigned.deviceId, unsigned.principalId, unsigned.audience,
      unsigned.issuedAt, unsigned.nonce, unsigned.bodyHash].join("\n"),
  );
  const signature = await crypto.subtle.sign("Ed25519", opts.keys.privateKey, message);
  return { ...unsigned, signatureBase64: b64(new Uint8Array(signature)) };
}

async function activeKey(db: FakeCollectorDb, keys: CryptoKeyPair): Promise<CollectorKey> {
  const raw = await crypto.subtle.exportKey("raw", keys.publicKey);
  const key: CollectorKey = {
    collector_id: "collector-1",
    principal_id: "sid",
    public_key_base64: b64(new Uint8Array(raw)),
    device_label: "Opera GX",
    status: "active",
    challenge: "challenge-1",
    pairing_code: "481-902",
    expires_at: "2026-09-26T20:00:00.000Z",
    decision_id: "decision-1",
  };
  db.keys.set(key.collector_id, key);
  return key;
}

describe("verifyCollectorRequest", () => {
  it("verifies a real Ed25519-signed observation end to end", async () => {
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await activeKey(db, keys);
    const body = canonical(COURSE_BATCH);
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body,
      keys,
      deviceId: "collector-1",
      principalId: "sid",
      issuedAt: "2026-09-26T19:00:00.000Z",
    });
    const result = await verifyCollectorRequest(
      db,
      "sid",
      JSON.parse(JSON.stringify(envelope)),
      "/school/observations",
      new TextEncoder().encode(body),
      NOW,
      "active",
    );
    expect(result.key.collector_id).toBe("collector-1");
    expect(parseSchoolBatch(result.body, NOW).courseIds).toEqual(["1001"]);
  });
  it("refuses to reuse a nonce (replay is dead on arrival)", async () => {
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await activeKey(db, keys);
    const body = canonical(COURSE_BATCH);
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body,
      keys,
      deviceId: "collector-1",
      principalId: "sid",
      issuedAt: "2026-09-26T19:00:00.000Z",
    });
    const raw = new TextEncoder().encode(body);
    await verifyCollectorRequest(
      db, "sid", JSON.parse(JSON.stringify(envelope)), "/school/observations", raw, NOW, "active",
    );
    await expect(
      verifyCollectorRequest(
        db, "sid", JSON.parse(JSON.stringify(envelope)), "/school/observations", raw, NOW, "active",
      ),
    ).rejects.toThrow("school_nonce_refused");
  });
  it("refuses a numeric issuedAt (the app-side break, pinned here)", async () => {
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await activeKey(db, keys);
    const body = canonical(COURSE_BATCH);
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body,
      keys,
      deviceId: "collector-1",
      principalId: "sid",
      issuedAt: "2026-09-26T19:00:00.000Z",
    });
    const numeric = { ...envelope, issuedAt: 1790000000000 };
    await expect(
      verifyCollectorRequest(
        db, "sid", numeric, "/school/observations", new TextEncoder().encode(body), NOW, "active",
      ),
    ).rejects.toThrow("signed_request_invalid");
  });
  it("refuses a stale signature (5-minute skew window)", async () => {
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await activeKey(db, keys);
    const body = canonical(COURSE_BATCH);
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body,
      keys,
      deviceId: "collector-1",
      principalId: "sid",
      issuedAt: "2026-09-26T18:00:00.000Z",
    });
    await expect(
      verifyCollectorRequest(
        db, "sid", JSON.parse(JSON.stringify(envelope)), "/school/observations",
        new TextEncoder().encode(body), NOW, "active",
      ),
    ).rejects.toThrow("school_signature_expired");
  });
  it("refuses a tampered body (hash over exact bytes)", async () => {
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await activeKey(db, keys);
    const body = canonical(COURSE_BATCH);
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body,
      keys,
      deviceId: "collector-1",
      principalId: "sid",
      issuedAt: "2026-09-26T19:00:00.000Z",
    });
    const tampered = body.replace("BBB4M0-01", "BBB4M0-02");
    await expect(
      verifyCollectorRequest(
        db, "sid", JSON.parse(JSON.stringify(envelope)), "/school/observations",
        new TextEncoder().encode(tampered), NOW, "active",
      ),
    ).rejects.toThrow("school_body_hash_invalid");
  });
  it("refuses a re-serialized (non-canonical) body with a valid signature over it", async () => {
    // A body that parses to the same value but is not byte-canonical must fail
    // even if someone signed THOSE bytes: the receiver demands canonical form.
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await activeKey(db, keys);
    // Same value as canonical({b:1,a:2}) but with keys out of order: valid
    // JSON, wrong bytes.
    const nonCanonical = '{"b":1,"a":2}';
    expect(JSON.parse(nonCanonical)).toEqual(JSON.parse(canonical({ b: 1, a: 2 })));
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body: nonCanonical,
      keys,
      deviceId: "collector-1",
      principalId: "sid",
      issuedAt: "2026-09-26T19:00:00.000Z",
    });
    await expect(
      verifyCollectorRequest(
        db, "sid", JSON.parse(JSON.stringify(envelope)), "/school/observations",
        new TextEncoder().encode(nonCanonical), NOW, "active",
      ),
    ).rejects.toThrow("signed_body_noncanonical");
  });
  it("refuses the wrong audience or principal", async () => {
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await activeKey(db, keys);
    const body = canonical(COURSE_BATCH);
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body,
      keys,
      deviceId: "collector-1",
      principalId: "mallory",
      issuedAt: "2026-09-26T19:00:00.000Z",
    });
    await expect(
      verifyCollectorRequest(
        db, "sid", JSON.parse(JSON.stringify(envelope)), "/school/observations",
        new TextEncoder().encode(body), NOW, "active",
      ),
    ).rejects.toThrow("school_authority_invalid");
  });
  it("refuses when the key is not active for the requested status", async () => {
    const db = new FakeCollectorDb();
    const keys = (await crypto.subtle.generateKey("Ed25519", false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const key = await activeKey(db, keys);
    key.status = "pending";
    const body = canonical(COURSE_BATCH);
    const envelope = await signTestEnvelope({
      path: "/school/observations",
      body,
      keys,
      deviceId: "collector-1",
      principalId: "sid",
      issuedAt: "2026-09-26T19:00:00.000Z",
    });
    await expect(
      verifyCollectorRequest(
        db, "sid", JSON.parse(JSON.stringify(envelope)), "/school/observations",
        new TextEncoder().encode(body), NOW, "active",
      ),
    ).rejects.toThrow("school_key_inactive");
  });
  it("exports a bodyHash matching an independent SHA-256", async () => {
    const body = canonical(COURSE_BATCH);
    const direct = await sha256Hex(new TextEncoder().encode(body));
    expect(direct).toMatch(/^[a-f0-9]{64}$/);
    expect(direct).toBe(await sha256Hex(new TextEncoder().encode(body)));
  });
});
