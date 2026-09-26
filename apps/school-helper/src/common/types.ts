/**
 * School Helper — shared domain types.
 * Everything here is persisted locally (IndexedDB) and never leaves the machine,
 * except for explicit, user-visible AI calls.
 */

export type BoardId = 'ldsb' | 'durham';

export interface BoardConfig {
  id: BoardId;
  label: string;
  origin: string; // e.g. https://ldsb.elearningontario.ca
  /** Durham is reached via SSO from the LDSB homepage widget. */
  reachedVia?: BoardId;
  ssoNote?: string;
}

export interface Course {
  id: string; // stable local id: `${board}:${orgUnitId}`
  board: BoardId;
  orgUnitId: string;
  code: string; // BBB4M0-01
  name: string;
  teacher: string;
  colour: string;
  active: boolean;
  /** Evaluation weights parsed from the course outline, e.g. { "Knowledge": 25 }. */
  weights?: Record<string, number>;
  outlineUrl?: string;
  lastSyncedAt?: number;
}

export type ItemKind =
  | 'unit'
  | 'lesson'
  | 'assignment' // D2L dropbox
  | 'quiz'
  | 'discussion'
  | 'announcement'
  | 'other';

export type SubmissionStatus =
  'not-started' | 'in-progress' | 'submitted' | 'graded' | 'returned' | 'unknown';

/** Fields a human may override. A manual edit here always wins over sync. */
export interface ManualOverride {
  field: string;
  value: unknown;
  editedAt: number;
}

export interface WorkItem {
  id: string; // `${courseId}:${kind}:${remoteId}`
  courseId: string;
  board: BoardId;
  kind: ItemKind;
  remoteId: string;
  title: string;
  /** Content-tree parent (unit/module) id, if any. */
  parentId?: string;
  /** Position within the parent, for stable tree ordering. */
  sortOrder?: number;
  url?: string;
  description?: string;

  dueAt?: number | null;
  endAt?: number | null;
  startAt?: number | null;

  points?: number | null;
  /** Percent of final grade, when the outline says so. */
  weight?: number | null;

  status: SubmissionStatus;
  submittedAt?: number | null;
  grade?: number | null;
  gradeMax?: number | null;
  feedback?: string | null;

  /** Dropboxes that content links to but that are hidden from the dropbox list. */
  hiddenFromList?: boolean;

  rubricIds?: string[];
  /** Sources the lesson itself provides — the only things answer-notes may read. */
  sources?: SourceRef[];

  completed?: boolean;
  notes?: string;
  tags?: string[];

  overrides?: Record<string, ManualOverride>;
  firstSeenAt: number;
  lastSeenAt: number;
  /** false once sync stops reporting it (never hard-delete user data). */
  presentInLastSync: boolean;
}

export interface SourceRef {
  kind: 'slides' | 'doc' | 'pdf' | 'link' | 'html' | 'video' | 'unknown';
  title: string;
  url: string;
  /** Set when the user names a source manually rather than the lesson providing it. */
  userProvided?: boolean;
}

export interface Rubric {
  id: string;
  courseId: string;
  itemId?: string;
  name: string;
  criteria: RubricCriterion[];
}

export interface RubricCriterion {
  name: string;
  /** Level-4 descriptor — the target we check work against. */
  level4: string;
  levels?: { name: string; descriptor: string; points?: number }[];
  points?: number;
}

export interface TeacherQuestion {
  id: string;
  courseId: string;
  teacher: string;
  question: string;
  context?: string;
  asked: boolean;
  answered: boolean;
  answer?: string;
  createdAt: number;
  updatedAt: number;
}

export type ChangeType =
  | 'new-item'
  | 'due-date'
  | 'new-grade'
  | 'new-feedback'
  | 'status'
  | 'new-announcement'
  | 'removed'
  | 'other';

export interface ChangeRecord {
  id: string;
  syncId: string;
  at: number;
  courseId: string;
  itemId?: string;
  type: ChangeType;
  title: string;
  detail: string;
  before?: unknown;
  after?: unknown;
  seen: boolean;
}

export interface SyncRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  trigger: 'manual' | 'browse' | 'alarm';
  boards: BoardId[];
  ok: boolean;
  itemsSeen: number;
  changes: number;
  errors: string[];
  /** Per-request log, GET-only, for the privacy review. */
  requests: { url: string; status: number; ms: number }[];
}

export interface AiCallRecord {
  id: string;
  at: number;
  role: AiRole;
  providerLabel: string;
  baseUrl: string;
  model: string;
  feature:
    | 'answer-notes'
    | 'rubric-check'
    | 'sync-summary'
    | 'email-draft'
    | 'day-summary'
    | 'scribe-cleanup'
    | 'other';
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  ok: boolean;
  error?: string;
}

export type AiRole = 'cheap' | 'strong';
export type AiProviderKind = 'openai-compatible' | 'anthropic';

export interface AiProviderConfig {
  kind: AiProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  /** Encrypted at rest; never logged, never exported unless explicitly requested. */
  apiKeyCipher?: string;
  /** Marks endpoints that stay on this machine (Ollama, LM Studio). */
  isLocal: boolean;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
  maxOutputTokens?: number;
}

export interface Settings {
  id: 'settings';
  theme: 'light' | 'dark' | 'system';
  providers: Record<AiRole, AiProviderConfig>;
  /** Hard block: refuse any AI call to a non-local endpoint. */
  localModelOnly: boolean;
  /** Show the "this data goes to X" confirmation before every call. */
  confirmBeforeAiCall: boolean;
  monthlyBudgetUsd: number | null;
  google: {
    clientId: string;
    /** Docs the user has explicitly picked. Scope is limited to these. */
    allowedDocIds: string[];
  };
  sync: {
    onBrowse: boolean;
    intervalMinutes: number;
    lastFullSyncAt?: number;
  };
  reminders: {
    enabled: boolean;
    leadHours: number[];
    endOfDaySummary: boolean;
    endOfDayHour: number;
  };
  captureFixtures: boolean;
  /** Jarvis link. Absent on databases created before v1.1.0. */
  jarvis?: JarvisSettings;
  schemaVersion: number;
}

export interface FixtureCapture {
  id: string;
  at: number;
  board: BoardId;
  endpoint: string;
  url: string;
  status: number;
  /** Redacted body. Names, emails and ids are scrubbed before storage. */
  body: string;
  redactions: number;
}

export interface UndoRecord {
  id: string;
  at: number;
  kind: 'gdocs-format';
  docId: string;
  title: string;
  /** Requests that reverse the applied batch, or a full snapshot restore. */
  payload: unknown;
  applied: boolean;
  revertedAt?: number;
}

export interface AnswerNote {
  question: string;
  bullets: { point: string; evidenceUrl?: string; evidenceQuote?: string; inSource: boolean }[];
  flags: string[];
  stance?: string;
}

/* ── Jarvis link ─────────────────────────────────────────────────────────── */

/** Which wire contract the link speaks. See docs/JARVIS-LINK.md. */
export type JarvisTransportKind = 'gateway';

export type JarvisPairingStatus = 'unpaired' | 'pending' | 'active' | 'expired' | 'unavailable-or-refused';

export interface JarvisSettings {
  enabled: boolean;
  transport: JarvisTransportKind;
  /** The gateway origin. https://, or http://localhost for testing. */
  baseUrl: string;
  appId: string;
  pairing?: {
    status: JarvisPairingStatus;
    collectorId?: string;
    principalId?: string;
    code?: string;
    expiresAt?: string;
    proved?: boolean;
    deviceLabel?: string;
  };
  /** Consecutive failed flushes; 3+ raises a dashboard warning. */
  failureStreak: number;
  /** Total change records dropped by the outbox cap, ever. Surfaced, never silent. */
  droppedTotal: number;
}

export interface JarvisLogEntry {
  id: string;
  at: number;
  endpoint: string;
  method: string;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  ok: boolean;
  itemCount: number;
  detail?: string;
}

/**
 * One queued observation batch. Shape mirrors src/jarvis/outbox.ts, which owns
 * the bounds and the retry policy.
 */
export interface JarvisOutboxEntry {
  id: string;
  /** Exact bytes to send. Never re-serialized: the signature covers these. */
  body: string;
  host: string;
  courseId: string;
  readId: string;
  itemCount: number;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  /** Set when the batch had to be sent as an explicit compact failure. */
  wireError?: string;
}

/* ── Scribe mode ─────────────────────────────────────────────────────────── */

export interface ScribeDiffToken {
  text: string;
  kind: 'same' | 'added' | 'removed';
  /** Added tokens that carry meaning — filler and punctuation are exempt. */
  meaningful: boolean;
}

export interface ScribeDiff {
  tokens: ScribeDiffToken[];
  /** Every meaningful word the cleanup introduced. Empty = nothing was added. */
  addedWords: string[];
  removedFiller: string[];
  clean: boolean;
}

export interface ScribeAnswer {
  questionId: string;
  prompt: string;
  /** Exactly as captured, before any cleanup. Never overwritten. */
  raw: string;
  cleaned?: string;
  diff?: ScribeDiff;
  accepted?: string;
  acceptedAt?: number;
  capturedAt: number;
  source: 'voice' | 'typed';
  cleanupError?: string;
}

export interface ScribeSession {
  id: string;
  itemId: string;
  courseId: string;
  title: string;
  prompts: { id: string; text: string }[];
  /** Where the prompts came from: parsed from the item, or pasted by Sid. */
  promptSource: 'description' | 'pasted';
  answers: ScribeAnswer[];
  createdAt: number;
  updatedAt: number;
}
