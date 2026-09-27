import type { Clock } from "../clock.js";
import { ConversationRepo, type ConversationStore } from "../conversation/conversation-repo.js";
import { PendingActionsRepo, type PendingStore } from "../confirmations/pending-actions.js";
import { ToolDispatcher } from "../confirmations/gate.js";
import { actionTools } from "../confirmations/action-tools.js";
import { reindexUnindexed, type EmbeddingProvider, type VectorIndex } from "../memory/embeddings.js";
import {
  MEMORY_REVIEW_QUIET_MS,
  MemoryReviewer,
  MemoryRunsRepo,
  type MemoryRunsStore,
} from "../memory/memory-review.js";
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
import type { D1Db } from "../persistence/d1.js";
import { CollectorKeys } from "../school/collector-keys.js";
import { EvidenceStore } from "../school/evidence-store.js";
import { SchoolRequests } from "../school/school-requests.js";
import { schoolTools, type SchoolServices } from "../school/school-tools.js";
import { callPlace } from "../channels/phone-tools.js";
import type { PhoneOut, PhoneServices } from "../channels/phone.js";
import type { TextMedium } from "../types.js";
import { emailList, emailRead, type EmailServices } from "../email/email-tools.js";
import { D1EmailsRepo, InMemoryEmailsRepo, type EmailsStore } from "../email/email-repo.js";
import type { EmailOut } from "../email/outbound.js";
import { pcTools, type PcServices } from "../pc/pc-tools.js";
import { D1PcHeartbeatRepo, type PcHeartbeatStore } from "../pc/pc-tools.js";
import { D1PcJobsRepo, type PcJobsStore } from "../pc/pc-jobs-repo.js";

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
  /** Object store for the conversation archive. Production: R2 (ARCHIVE). Defaults to in-memory. */
  bucket?: Bucket;
  /** Object store for nightly backups. Production: R2 (BACKUP). Defaults to `bucket`. */
  backupBucket?: Bucket;
  /** MEMORY_EXTRACTION_MODEL: memory reviews run on this when set; otherwise on `model`. */
  extractionModel?: Model;
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
    memoryRuns?: MemoryRunsStore;
    emails?: EmailsStore;
    pcJobs?: PcJobsStore;
    pcHeartbeat?: PcHeartbeatStore;
  };
  /**
   * D1 database. When present, the school surface (collector keys, evidence,
   * request queue) is constructed and the 7 school tools are registered. When
   * absent the school tools fail closed with not_connected.
   */
  db?: D1Db;
  /** Twilio outbound (SMS + calls). Absent => phone tools return not_connected. */
  phone?: { rest: PhoneOut; ownerPhone?: string; publicOrigin?: string };
  /** Outbound email (Gmail API / Microsoft Graph). Absent => send_email returns not_connected. */
  emailSender?: EmailOut;
  /** Which text channels exist and which Sid used last (shown in the prompt). */
  textChannels?: () => Promise<{ available: TextMedium[]; lastUsed?: TextMedium }>;
}

export interface BuiltJarvis {
  ownerChannel: OwnerChannel;
  phone?: PhoneServices;
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
  backupBucket: Bucket;
  memoryRuns: MemoryRunsStore;
  reviewer: MemoryReviewer;
  /** Hourly: put active facts that missed the meaning index into it. */
  reindex: () => ReturnType<typeof reindexUnindexed>;
  school?: SchoolServices;
  /** Inbound email store (serves the DO's email wake handler + email tools). */
  emails: EmailsStore;
  /** Outbound email sender, when configured (Gmail API / Microsoft Graph). */
  emailSender: EmailOut | undefined;
  /** PC job queue, when the PC surface is wired. */
  pcJobs: PcJobsStore | undefined;
  /** PC heartbeat store, when the PC surface is wired. */
  pcHeartbeat: PcHeartbeatStore | undefined;
}

/** Wire the whole brain together. Used by the DO, local runner and tests. */
export function buildJarvis(input: BuildInput): BuiltJarvis {
  const facts = input.stores?.facts ?? new FactsRepo(input.clock);
  const conversation = input.stores?.conversation ?? new ConversationRepo(input.clock);
  const receipts = input.stores?.receipts ?? new ReceiptsRepo(input.clock);
  const pending = input.stores?.pending ?? new PendingActionsRepo(input.clock);
  const settings = input.stores?.settings ?? new SettingsRepo();

  const school: SchoolServices | undefined = input.db
    ? {
        keys: new CollectorKeys(input.db),
        evidence: new EvidenceStore(input.db),
        requests: new SchoolRequests(input.db),
      }
    : undefined;

  const phone: PhoneServices | undefined = input.phone
    ? { rest: input.phone.rest, ownerPhone: input.phone.ownerPhone, publicOrigin: input.phone.publicOrigin, settings }
    : undefined;

  const emails = input.stores?.emails ?? (input.db ? new D1EmailsRepo(input.db) : new InMemoryEmailsRepo());
  const emailServices: EmailServices = { repo: emails, ...(input.emailSender ? { sender: input.emailSender } : {}) };

  // The PC queue must persist (a queued job must survive an eviction), so the
  // PC surface is only wired when D1 (or an explicit test store) is present.
  const pcJobs = input.stores?.pcJobs ?? (input.db ? new D1PcJobsRepo(input.db, input.clock) : undefined);
  const pcHeartbeat = input.stores?.pcHeartbeat ?? (input.db ? new D1PcHeartbeatRepo(input.db, input.clock) : undefined);
  const pcServices: PcServices | undefined = pcJobs && pcHeartbeat ? { jobs: pcJobs, heartbeat: pcHeartbeat } : undefined;

  const dispatcher = new ToolDispatcher([
    ...memoryTools,
    ...actionTools,
    ...appTools,
    ...voiceTools,
    ...wakeupTools,
    ...(school ? schoolTools : []),
    ...pcTools,
    emailList,
    emailRead,
    archiveSearch,
    sendText,
    callPlace,
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
  const memoryRuns = input.stores?.memoryRuns ?? new MemoryRunsRepo(input.clock);
  const backupBucket = input.backupBucket ?? bucket;
  // With D1 bound, the backup dumps EVERY table in the database (read from
  // sqlite_master), so a table added later is never forgotten. Without D1 it
  // falls back to the in-memory stores.
  const backup = input.db
    ? BackupService.fromD1(backupBucket, input.clock, input.db)
    : new BackupService(backupBucket, input.clock, {
        facts: () => facts.all(),
        messages: () => conversation.all(),
        pending_actions: () => pending.all(),
        wakeups: () => wakeupsRepo.list(),
        guests: () => guests.list(),
        connected_apps: () => appsRepo.list(),
        receipts: () => receipts.all(),
        memory_runs: () => memoryRuns.all(),
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
    ...(school ? { school } : {}),
    ...(phone ? { phone } : {}),
    ...(emailServices ? { email: emailServices } : {}),
    ...(pcServices ? { pc: pcServices } : {}),
    ...(input.textChannels ? { textChannels: input.textChannels } : {}),
    ...(input.pinPepper ? { pinPepper: input.pinPepper } : {}),
    // Each live exchange pushes the quiet-conversation memory review later.
    afterOwnerTurn: async () => {
      const at = new Date(input.clock.nowMs() + MEMORY_REVIEW_QUIET_MS).toISOString();
      await wakeups.setSystemTimer("memory_review", at, "memory review: the conversation went quiet");
    },
  });

  const reviewer = new MemoryReviewer({
    conversation,
    runs: memoryRuns,
    agent,
    modelName: (input.extractionModel ?? input.model).name ?? "unknown",
    ...(input.extractionModel ? { extractionModel: input.extractionModel } : {}),
  });
  const reindex = () => reindexUnindexed(facts, input.embeddings, input.vectors);

  return {
    agent,
    ownerChannel: input.ownerChannel,
    ...(phone ? { phone } : {}),
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
    backupBucket,
    memoryRuns,
    reviewer,
    reindex,
    ...(school ? { school } : {}),
    emails,
    emailSender: input.emailSender,
    pcJobs: pcServices ? pcJobs : undefined,
    pcHeartbeat: pcServices ? pcHeartbeat : undefined,
  };
}
