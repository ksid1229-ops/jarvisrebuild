import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { AgentCore, AgentResult, JarvisEvent } from "../jarvis/agent-core.js";

export interface AppEvent {
  id: string;
  appName: string;
  payloadJson: string;
  receivedAt: string;
}

/** Stores app events (senses). Each event wakes Jarvis with the app + raw payload. */
export class AppEventsRepo {
  private readonly events: AppEvent[] = [];
  constructor(private readonly clock: Clock) {}

  store(appName: string, payload: unknown): AppEvent {
    const ev: AppEvent = {
      id: newId("appevt"),
      appName,
      payloadJson: JSON.stringify(payload),
      receivedAt: this.clock.nowIso(),
    };
    this.events.push(ev);
    return ev;
  }
  all(): AppEvent[] {
    return [...this.events];
  }
}

/**
 * Wake Jarvis with an app event. The raw payload and app name are handed to the
 * model, which DECIDES what it means and whether it is worth interrupting Sid
 * for (it may call send_text, or stay quiet). Code decides nothing here.
 */
export async function wakeOnAppEvent(
  agent: AgentCore,
  event: AppEvent,
  ownerId: string,
): Promise<AgentResult> {
  const jarvisEvent: JarvisEvent = {
    channel: "text",
    trigger: "app_event",
    eventId: newId("evt"),
    text: `Event from connected app '${event.appName}': ${event.payloadJson}`,
    provenance: {
      channel: "text",
      isOwner: true,
      isForwarded: false,
      isPrivate: true,
      sourceRef: `app:${event.appName}:${event.id}`,
      sourceType: "app",
    },
  };
  return agent.handle(jarvisEvent);
}
