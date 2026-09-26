import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { ConnectedApp } from "../types.js";

/** The connector registry (D1 table `connected_apps`). In-memory here. */
export class ConnectedAppsRepo {
  private readonly apps = new Map<string, ConnectedApp>();
  constructor(private readonly clock: Clock) {}

  add(input: { name: string; baseUrl: string; authSecret: string }): ConnectedApp {
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

  get(id: string): ConnectedApp | undefined {
    return this.apps.get(id);
  }
  byName(name: string): ConnectedApp | undefined {
    for (const a of this.apps.values()) if (a.name === name) return a;
    return undefined;
  }
  remove(id: string): boolean {
    return this.apps.delete(id);
  }
  list(): ConnectedApp[] {
    return [...this.apps.values()];
  }
}
