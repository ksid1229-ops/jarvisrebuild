import type { D1Db, D1Row } from "../persistence/d1.js";
import { str } from "../persistence/d1.js";

/**
 * Settings (Phase 4). A global shadow flag plus per-feature flags. Sid turns
 * shadow on/off by just saying so; the model calls settings_update. Shadow
 * state is injected into the system prompt.
 */
export interface SettingsStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  all(): Promise<Record<string, string>>;
  /** Global shadow mode. Default OFF, but explicit — not a silent default of behaviour. */
  isShadow(): Promise<boolean>;
  isFeatureShadow(feature: string): Promise<boolean>;
}

export class SettingsRepo implements SettingsStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async all(): Promise<Record<string, string>> {
    return Object.fromEntries(this.map);
  }

  async isShadow(): Promise<boolean> {
    return this.map.get("shadow") === "on";
  }
  async isFeatureShadow(feature: string): Promise<boolean> {
    return (await this.isShadow()) || this.map.get(`shadow:${feature}`) === "on";
  }
}

/** D1-backed settings. Same interface, real persistence. */
export class D1SettingsRepo implements SettingsStore {
  constructor(private readonly db: D1Db) {}

  async get(key: string): Promise<string | undefined> {
    const row = await this.db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<D1Row>();
    return row ? str(row.value, "settings.value") : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).bind(key, value).run();
  }

  async all(): Promise<Record<string, string>> {
    const res = await this.db.prepare(`SELECT key, value FROM settings`).all<D1Row>();
    const out: Record<string, string> = {};
    for (const row of res.results) out[str(row.key, "settings.key")] = str(row.value, "settings.value");
    return out;
  }

  async isShadow(): Promise<boolean> {
    return (await this.get("shadow")) === "on";
  }

  async isFeatureShadow(feature: string): Promise<boolean> {
    return (await this.isShadow()) || (await this.get(`shadow:${feature}`)) === "on";
  }
}
