import { FixedClock } from "../src/clock.js";
import { FakeModel, type ScriptedTurn } from "../src/model/fake-model.js";
import { FakeEmbeddingProvider, InMemoryVectorIndex } from "../src/memory/embeddings.js";
import { FakeOwnerChannel } from "../src/channels/fake-owner-channel.js";
import { buildJarvis, type BuiltJarvis } from "../src/jarvis/build.js";
import type { JarvisEvent } from "../src/jarvis/agent-core.js";
import type { ToolContext } from "../src/jarvis/tool-types.js";
import type { Channel, ConnectedApp, Provenance, Trigger } from "../src/types.js";
import type { AppConnector } from "../src/apps/connector.js";

export interface Harness extends BuiltJarvis {
  clock: FixedClock;
  model: FakeModel;
  vectors: InMemoryVectorIndex;
  embeddings: FakeEmbeddingProvider;
  ownerChannel: FakeOwnerChannel;
  ctxFor(event: JarvisEvent, currentMessageId?: string): ToolContext;
}

export function makeHarness(
  turns: ScriptedTurn[],
  opts: {
    clock?: FixedClock;
    makeConnector?: (app: ConnectedApp) => AppConnector;
    ownerPin?: string;
    pinPepper?: string;
    db?: import("../src/persistence/d1.js").D1Db;
    extractionModel?: import("../src/model/types.js").Model;
    bucket?: import("../src/plumbing/bucket.js").Bucket;
    embeddings?: import("../src/memory/embeddings.js").EmbeddingProvider;
    stores?: import("../src/jarvis/build.js").BuildInput["stores"];
    setAlarm?: import("../src/scheduler/wakeup-scheduler.js").SetAlarm;
    phone?: import("../src/jarvis/build.js").BuildInput["phone"];
    textChannels?: import("../src/jarvis/build.js").BuildInput["textChannels"];
    emailSender?: import("../src/email/outbound.js").EmailOut;
  } = {},
): Harness {
  const clock = opts.clock ?? new FixedClock();
  const model = new FakeModel(turns);
  const embeddings = (opts.embeddings ?? new FakeEmbeddingProvider()) as FakeEmbeddingProvider;
  const vectors = new InMemoryVectorIndex();
  const ownerChannel = new FakeOwnerChannel();
  const built = buildJarvis({
    model,
    clock,
    embeddings,
    vectors,
    ownerChannel,
    ownerId: "sid",
    timezone: "America/Toronto",
    ...(opts.makeConnector ? { makeConnector: opts.makeConnector } : {}),
    ...(opts.ownerPin ? { ownerPin: opts.ownerPin } : {}),
    ...(opts.pinPepper ? { pinPepper: opts.pinPepper } : {}),
    ...(opts.db ? { db: opts.db } : {}),
    ...(opts.extractionModel ? { extractionModel: opts.extractionModel } : {}),
    ...(opts.bucket ? { bucket: opts.bucket } : {}),
    ...(opts.stores ? { stores: opts.stores } : {}),
    ...(opts.setAlarm ? { setAlarm: opts.setAlarm } : {}),
    ...(opts.phone ? { phone: opts.phone } : {}),
    ...(opts.textChannels ? { textChannels: opts.textChannels } : {}),
    ...(opts.emailSender ? { emailSender: opts.emailSender } : {}),
  });
  return {
    ...built,
    clock,
    model,
    embeddings,
    vectors,
    ownerChannel,
    ctxFor(event: JarvisEvent, currentMessageId?: string): ToolContext {
      return {
        ...(currentMessageId ? { currentMessageId } : {}),
        clock,
        ownerId: "sid",
        provenance: event.provenance,
        trigger: event.trigger,
        eventId: event.eventId,
        ownerMessageText: event.text,
        facts: built.facts,
        conversation: built.conversation,
        receipts: built.receipts,
        pending: built.pending,
        settings: built.settings,
        embeddings,
        vectors,
        ownerChannel,
        apps: built.apps,
        call: event.call,
        ownerPinVerifier: built.ownerPinVerifier,
        guests: built.guests,
        wakeups: built.wakeups,
        archive: built.archive,
        school: built.school,
        phone: built.phone,
        email: { repo: built.emails, ...(built.emailSender ? { sender: built.emailSender } : {}) },
        pc: built.pcJobs && built.pcHeartbeat ? { jobs: built.pcJobs, heartbeat: built.pcHeartbeat } : undefined,
      };
    },
  };
}

import { newCallSession, type CallSession } from "../src/voice/call-session.js";

/** A voice-call event. Pass a CallSession to carry caller role + PIN state. */
export function callEvent(text: string, call: CallSession, eventId = "c1"): JarvisEvent {
  return {
    channel: "voice",
    trigger: "call",
    eventId,
    text,
    call,
    provenance: {
      channel: "voice",
      isOwner: call.role === "owner",
      isForwarded: false,
      isPrivate: true,
      sourceRef: `call:${call.callId}:${eventId}`,
      sourceType: "call",
    },
  };
}

export { newCallSession };
export type { CallSession };

export function ownerEvent(
  text: string,
  eventId = "e1",
  overrides: Partial<{ channel: Channel; trigger: Trigger; provenance: Partial<Provenance> }> = {},
): JarvisEvent {
  const channel = overrides.channel ?? "text";
  const trigger = overrides.trigger ?? "text";
  return {
    channel,
    trigger,
    eventId,
    text,
    provenance: {
      channel,
      isOwner: true,
      isForwarded: false,
      isPrivate: true,
      sourceRef: `telegram:sid:${eventId}`,
      sourceType: "conversation",
      ...overrides.provenance,
    },
  };
}
