import type { Clock } from "../clock.js";
import { ConversationRepo, type ConversationStore } from "../conversation/conversation-repo.js";
import { PendingActionsRepo, type PendingStore } from "../confirmations/pending-actions.js";
import { ToolDispatcher } from "../confirmations/gate.js";
import { actionTools } from "../confirmations/action-tools.js";
import type { EmbeddingProvider, VectorIndex } from "../memory/embeddings.js";
import { FactsRepo, type FactsStore } from "../memory/facts-repo.js";
import { memoryTools } from "../memory/memory-tools.js";
import { ReceiptsRepo, type ReceiptsStore } from "../receipts/receipts-repo.js";
import { SettingsRepo, type SettingsStore } from "../settings/settings-repo.js";
import type { Model } from "../model/types.js";
import { AgentCore } from "./agent-core.js";
import { makeConfirmTools, receiptsQuery, sendText, settingsUpdate } from "./core-tools.js";
import type { OwnerChannel } from "./tool-types.js";
import { ConnectedAppsRepo, type ConnectedAppsStore } from "../apps/app-registry.js";
import { AppManager } from "../apps/app-manager.js";
import { appTools } from "../apps/app-tools.js";
import { HttpAppConnector, type AppConnector } from "../apps/connector.js";
import type { ConnectedApp } from "../types.js";
import { voiceTools } from "../voice/voice-tools.js";
import { GuestsRepo, type GuestsStore } from "../voice/guests-repo.js";
import { makeOwnerPinVerifier, type OwnerPinVerifier } from "../voice/pin.js";
import { WakeupsRepo, type WakeupsStore } from "../scheduler/wakeups-repo.js";
import { WakeupScheduler, type SetAlarm } from "../scheduler/wakeup-scheduler.js";
import { wakeupTools } from "../scheduler/wakeup-tools.js";
import { InMemoryBucket, type Bucket } from "../plumbing/bucket.js";
import { ArchiveService, archiveSearch } from "../plumbing/archive.js";
import { BackupService } from "../plumbing/backup.js";
import { HeartbeatRepo, type HeartbeatStore } from "../plumbing/heartbeat.js";
import { WatchdogPinger } from "../plumbing/watchdog.js";

export interface BuildInput {
  model: Model;
  clock: Clock;
  embeddings: EmbeddingProvider;
  vectors: VectorIndex;
  ownerChannel: OwnerChannel;
  ownerId: string;
  timezone: string;
  /** Override how an app connector is built (tests inject an in-process fake). */
  makeConnector?: (app: ConnectedApp) => AppConnector;
  /** Owner PIN config for the five actions on a call. Missing => fail closed. */
  ownerPin?: string;
  pinPepper?: string;
  /** Object store for backup/archive/vault. Defaults to an in-memory bucket. */
  bucket?: Bucket;
  /** Points the single DO alarm at the earliest wake-up. Defaults to a no-op. */
  setAlarm?: SetAlarm;
  /** External watchdog ping URL (Healthchecks.io). Missing => not_connected. */
  watchdogUrl?: string;
  /**
   * Storage overrides. Production passes D1-backed stores here (see the DO's
   * ensureBuilt); tests and local runs default to the in-memory stores.
   */
  stores?: {
    facts?: FactsStore;
    conversation?: ConversationStore;
    receipts?: ReceiptsStore;
    pending?: PendingStore;
    settings?: SettingsStore;
    appsRepo?: ConnectedAppsStore;
    guests?: GuestsStore;
    wakeupsRepo?: WakeupsStore;
    heartbeat?: HeartbeatStore;
  };
}

export interface BuiltJarvis {
  agent: AgentCore;
  dispatcher: ToolDispatcher;
  facts: FactsStore;
  conversation: ConversationStore;
  receipts: ReceiptsStore;
  pending: PendingStore;
  settings: SettingsStore;
  apps: AppManager;
  appsRepo: ConnectedAppsStore;
  guests: GuestsStore;
  ownerPinVerifier: OwnerPinVerifier;
  wakeups: WakeupScheduler;
  wakeupsRepo: WakeupsStore;
  archive: ArchiveService;
  backup: BackupService;
  heartbeat: HeartbeatStore;
  watchdog: WatchdogPinger;
  bucket: Bucket;
}

/** Wire the whole brain together. Used by the DO, local runner and tests. */
export function buildJarvis(input: BuildInput): BuiltJarvis {
  const facts = input.stores?.facts ?? new FactsRepo(input.clock);
  const conversation = input.stores?.conversation ?? new ConversationRepo(input.clock);
  const receipts = input.stores?.receipts ?? new ReceiptsRepo(input.clock);
  const pending = input.stores?.pending ?? new PendingActionsRepo(input.clock);
  const settings = input.stores?.settings ?? new SettingsRepo();

  const dispatcher = new ToolDispatcher([
    ...memoryTools,
    ...actionTools,
    ...appTools,
    ...voiceTools,
    ...wakeupTools,
    archiveSearch,
    sendText,
    receiptsQuery,
    settingsUpdate,
  ]);

  // confirm/cancel need a reference to the dispatcher's executeConfirmed.
  const confirmTools = makeConfirmTools((pendingId, ctx) => dispatcher.executeConfirmed(pendingId, ctx));
  for (const t of confirmTools) dispatcher.register(t);

  const appsRepo = input.stores?.appsRepo ?? new ConnectedAppsRepo(input.clock);
  const makeConnector =
    input.makeConnector ?? ((app: ConnectedApp) => new HttpAppConnector(app.baseUrl, app.authSecret));
  const apps = new AppManager(appsRepo, dispatcher, makeConnector);

  const guests = input.stores?.guests ?? new GuestsRepo(input.clock);
  const ownerPinVerifier = makeOwnerPinVerifier(input.ownerPin, input.pinPepper);

  const wakeupsRepo = input.stores?.wakeupsRepo ?? new WakeupsRepo(input.clock);
  const wakeups = new WakeupScheduler(wakeupsRepo, input.clock, input.setAlarm);
  const bucket = input.bucket ?? new InMemoryBucket();
  const archive = new ArchiveService(bucket, input.clock);
  const heartbeat = input.stores?.heartbeat ?? new HeartbeatRepo(input.clock);
  const watchdog = new WatchdogPinger(input.watchdogUrl);
  const backup = new BackupService(bucket, input.clock, {
    facts: () => facts.all(),
    pending_actions: async () => [], // exposed via repo internals in production; empty view here
    wakeups: () => wakeupsRepo.list(),
    guests: () => guests.list(),
    connected_apps: () => appsRepo.list(),
    receipts: () => receipts.all(),
    settings: async () => Object.entries(await settings.all()).map(([key, value]) => ({ key, value })),
  });

  const agent = new AgentCore({
    model: input.model,
    dispatcher,
    facts,
    conversation,
    receipts,
    pending,
    settings,
    embeddings: input.embeddings,
    vectors: input.vectors,
    clock: input.clock,
    ownerChannel: input.ownerChannel,
    timezone: input.timezone,
    ownerId: input.ownerId,
    apps,
    guests,
    ownerPinVerifier,
    wakeups,
    archive,
    ...(input.pinPepper ? { pinPepper: input.pinPepper } : {}),
  });

  return {
    agent,
    dispatcher,
    facts,
    conversation,
    receipts,
    pending,
    settings,
    apps,
    appsRepo,
    guests,
    ownerPinVerifier,
    wakeups,
    wakeupsRepo,
    archive,
    backup,
    heartbeat,
    watchdog,
    bucket,
  };
}
