import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { D1Db, D1Row } from "../persistence/d1.js";
import { str } from "../persistence/d1.js";
import type { AgentCore, AgentResult, JarvisEvent } from "../jarvis/agent-core.js";

export interface AppEvent {
  id: string;
  appName: string;
  payloadJson: string;
  receivedAt: string;
}

/** Stores app events (senses). Each event wakes Jarvis with the app + raw payload. */
export interface AppEventsStore {
  store(appName: string, payload: unknown): Promise<AppEvent>;
  all(): Promise<AppEvent[]>;
}

export class AppEventsRepo implements AppEventsStore {
  private readonly events: AppEvent[] = [];
  constructor(private readonly clock: Clock) {}

  async store(appName: string, payload: unknown): Promise<AppEvent> {
    const ev: AppEvent = {
      id: newId("appevt"),
      appName,
      payloadJson: JSON.stringify(payload),
      receivedAt: this.clock.nowIso(),
    };
    this.events.push(ev);
    return ev;
  }
  async all(): Promise<AppEvent[]> {
    return [...this.events];
  }
}

function rowToEvent(row: D1Row): AppEvent {
  return {
    id: str(row.id, "app_events.id"),
    appName: str(row.app_name, "app_events.app_name"),
    payloadJson: str(row.payload_json, "app_events.payload_json"),
    receivedAt: str(row.received_at, "app_events.received_at"),
  };
}

/** D1-backed app events. Same interface, real persistence. */
export class D1AppEventsRepo implements AppEventsStore {
  constructor(
    private readonly db: D1Db,
    private readonly clock: Clock,
  ) {}

  async store(appName: string, payload: unknown): Promise<AppEvent> {
    const ev: AppEvent = {
      id: newId("appevt"),
      appName,
      payloadJson: JSON.stringify(payload),
      receivedAt: this.clock.nowIso(),
    };
    await this.db
      .prepare(`INSERT INTO app_events (id, app_name, payload_json, received_at) VALUES (?, ?, ?, ?)`)
      .bind(ev.id, ev.appName, ev.payloadJson, ev.receivedAt)
      .run();
    return ev;
  }

  async all(): Promise<AppEvent[]> {
    const res = await this.db.prepare(`SELECT * FROM app_events ORDER BY rowid ASC`).all<D1Row>();
    return res.results.map(rowToEvent);
  }
}

/**
 * Wake Jarvis with an app event. The raw payload and app name are handed to the
 * model, which DECIDES what it means and whether it is worth interrupting Sid
 * for (it may call send_text, or stay quiet). Code decides nothing here.
 */
/**
 * The JarvisEvent for an app event. Exported so tests can hold the WIRE itself
 * to account, not just its downstream effects.
 *
 * Provenance (audit round 4, following the email wake's precedent): an app's
 * payload is machine-reported data from a third party — never Sid's words and
 * never an instruction from him — so isOwner is FALSE and the source type is
 * "app" with the app's name. The system prompt labels the turn AUTOMATED EVENT
 * (audit round 3); this boolean is the hard wire under that label.
 */
export function appEventFrom(event: AppEvent): JarvisEvent {
  return {
    channel: "text",
    trigger: "app_event",
    eventId: newId("evt"),
    text: `Event from connected app '${event.appName}': ${event.payloadJson}`,
    provenance: {
      channel: "text",
      isOwner: false,
      isForwarded: false,
      isPrivate: true,
      sourceRef: `app:${event.appName}:${event.id}`,
      sourceName: event.appName,
      sourceType: "app",
    },
  };
}

export async function wakeOnAppEvent(
  agent: AgentCore,
  event: AppEvent,
  ownerId: string,
): Promise<AgentResult> {
  void ownerId; // identity is not the app's business; provenance says whose words they are
  return agent.handle(appEventFrom(event));
}
