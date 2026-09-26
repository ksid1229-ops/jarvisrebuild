/**
 * Collector device keys (D1 table school_collector_keys). Pairing turns a
 * pending key active; revoking flips it to revoked, which beats any in-flight
 * signature check (the nonce insert re-checks status).
 */
import type { D1Db, D1Row } from "../persistence/d1.js";
import { optStr, str } from "../persistence/d1.js";
import type { CollectorKey } from "./collector-protocol.js";

export function rowToCollectorKey(row: D1Row): CollectorKey {
  return {
    collector_id: str(row.collector_id, "keys.collector_id"),
    principal_id: str(row.principal_id, "keys.principal_id"),
    public_key_base64: str(row.public_key_base64, "keys.public_key_base64"),
    device_label: str(row.device_label, "keys.device_label"),
    status: str(row.status, "keys.status") as CollectorKey["status"],
    challenge: str(row.challenge, "keys.challenge"),
    pairing_code: str(row.pairing_code, "keys.pairing_code"),
    expires_at: str(row.expires_at, "keys.expires_at"),
    decision_id: optStr(row.decision_id, "keys.decision_id"),
  };
}

export class CollectorKeys {
  constructor(private readonly db: D1Db) {}

  async createPending(key: CollectorKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO school_collector_keys
         (collector_id, principal_id, public_key_base64, device_label, status,
          challenge, pairing_code, expires_at, decision_id)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(
        key.collector_id, key.principal_id, key.public_key_base64, key.device_label,
        key.challenge, key.pairing_code, key.expires_at, key.decision_id,
      )
      .run();
  }

  async get(collectorId: string): Promise<CollectorKey | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM school_collector_keys WHERE collector_id = ?`)
      .bind(collectorId)
      .first<D1Row>();
    return row ? rowToCollectorKey(row) : undefined;
  }

  async byCode(pairingCode: string): Promise<CollectorKey | undefined> {
    const row = await this.db
      .prepare(`SELECT * FROM school_collector_keys WHERE pairing_code = ? AND status = 'pending'`)
      .bind(pairingCode)
      .first<D1Row>();
    return row ? rowToCollectorKey(row) : undefined;
  }

  /** Approve a pending pairing. Returns false when there is nothing to approve. */
  async approve(collectorId: string, decisionId: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE school_collector_keys SET status = 'active', decision_id = ?
         WHERE collector_id = ? AND status = 'pending'`,
      )
      .bind(decisionId, collectorId)
      .run();
    return res.changes > 0;
  }

  async revoke(collectorId: string): Promise<boolean> {
    const res = await this.db
      .prepare(`UPDATE school_collector_keys SET status = 'revoked' WHERE collector_id = ?`)
      .bind(collectorId)
      .run();
    return res.changes > 0;
  }

  async list(): Promise<CollectorKey[]> {
    const res = await this.db.prepare(`SELECT * FROM school_collector_keys`).all<D1Row>();
    return res.results.map(rowToCollectorKey);
  }
}
