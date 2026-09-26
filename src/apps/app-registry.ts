import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { bool, str } from "../persistence/d1.js";
import type { ConnectedApp } from "../types.js";

export interface AddAppInput {
  name: string;
  baseUrl: string;
  authSecret: string;
}

/** The connector registry (D1 table `connected_apps`). */
export interface ConnectedAppsStore {
  add(input: AddAppInput): Promise<ConnectedApp>;
  get(id: string): Promise<ConnectedApp | undefined>;
  byName(name: string): Promise<ConnectedApp | undefined>;
  remove(id: string): Promise<boolean>;
  list(): Promise<ConnectedApp[]>;
}

export class ConnectedAppsRepo implements ConnectedAppsStore {
  private readonly apps = new Map<string, ConnectedApp>();
  constructor(private readonly clock: Clock) {}

  async add(input: AddAppInput): Promise<ConnectedApp> {
    const app: ConnectedApp = {
      id: newId("app"),
      name: input.name,
      baseUrl: input.baseUrl,
      authSecret: input.authSecret,
      enabled: true,
      addedAt: this.clock.nowIso(),
    };
    this.apps.set(app.id, app);
    return app;
  }

  async get(id: string): Promise<ConnectedApp | undefined> {
    return this.apps.get(id);
  }
  async byName(name: string): Promise<ConnectedApp | undefined> {
    for (const a of this.apps.values()) if (a.name === name) return a;
    return undefined;
  }
  async remove(id: string): Promise<boolean> {
    return this.apps.delete(id);
  }
  async list(): Promise<ConnectedApp[]> {
    return [...this.apps.values()];
  }
}

function rowToApp(row: D1Row): ConnectedApp {
  return {
    id: str(row.id, "connected_apps.id"),
    name: str(row.name, "connected_apps.name"),
    baseUrl: str(row.base_url, "connected_apps.base_url"),
    authSecret: str(row.auth_secret, "connected_apps.auth_secret"),
    enabled: bool(row.enabled, "connected_apps.enabled"),
    addedAt: str(row.added_at, "connected_apps.added_at"),
  };
}

/** D1-backed app registry. Same interface, real persistence. */
export class D1ConnectedAppsRepo implements ConnectedAppsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async add(input: AddAppInput): Promise<ConnectedApp> {
    const app: ConnectedApp = {
      id: newId("app"),
      name: input.name,
      baseUrl: input.baseUrl,
      authSecret: input.authSecret,
      enabled: true,
      addedAt: this.clock.nowIso(),
    };
    await this.db
      .prepare(
        `INSERT INTO connected_apps (id, name, base_url, auth_secret, enabled, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(app.id, app.name, app.baseUrl, app.authSecret, app.enabled ? 1 : 0, app.addedAt)
      .run();
    return app;
  }

  async get(id: string): Promise<ConnectedApp | undefined> {
    const row = await this.db.prepare(`SELECT * FROM connected_apps WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToApp(row) : undefined;
  }

  async byName(name: string): Promise<ConnectedApp | undefined> {
    const row = await this.db.prepare(`SELECT * FROM connected_apps WHERE name = ?`).bind(name).first<D1Row>();
    return row ? rowToApp(row) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.db.prepare(`DELETE FROM connected_apps WHERE id = ?`).bind(id).run();
    return res.changes > 0;
  }

  async list(): Promise<ConnectedApp[]> {
    const res = await this.db.prepare(`SELECT * FROM connected_apps`).all<D1Row>();
    return res.results.map(rowToApp);
  }
}
