import type { BoardConfig, Settings } from './types';

export const SCHEMA_VERSION = 1;

export const BOARDS: Record<string, BoardConfig> = {
  ldsb: {
    id: 'ldsb',
    label: 'LDSB Minds Online',
    origin: 'https://ldsb.elearningontario.ca',
  },
  durham: {
    id: 'durham',
    label: 'Durham DSB (via LDSB SSO)',
    origin: 'https://durham.elearningontario.ca',
    reachedVia: 'ldsb',
    ssoNote:
      'Reached from the LDSB homepage widget "My Courses in Other Boards". Sync follows that link to establish the Durham session cookie before reading.',
  },
};

/** The three courses from the build brief. Org unit ids are known up front. */
export const SEED_COURSES = [
  {
    board: 'ldsb' as const,
    orgUnitId: '29940528',
    code: 'BBB4M0-01',
    name: 'International Business',
    teacher: 'Ms. Pardy',
    colour: '#3b82f6',
  },
  {
    board: 'ldsb' as const,
    orgUnitId: '29940585',
    code: 'ENG4UE-02',
    name: 'English',
    teacher: 'Ms. McLaren',
    colour: '#a855f7',
  },
  {
    board: 'durham' as const,
    orgUnitId: '29725166',
    code: 'CIA4U',
    name: 'Economics',
    teacher: 'Mr. Fong',
    colour: '#10b981',
  },
];

export const GOOGLE_ACCOUNTS = {
  school: '/u/1',
  personal: '/u/0',
};

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  theme: 'system',
  providers: {
    cheap: {
      kind: 'openai-compatible',
      label: 'Cheap model (sync summaries, tracker updates)',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      isLocal: false,
      inputCostPerMTok: 0.27,
      outputCostPerMTok: 1.1,
      maxOutputTokens: 2048,
    },
    strong: {
      kind: 'openai-compatible',
      label: 'Strong model (rubric checks, essay feedback)',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      isLocal: false,
      inputCostPerMTok: 2.5,
      outputCostPerMTok: 10,
      maxOutputTokens: 4096,
    },
  },
  localModelOnly: false,
  confirmBeforeAiCall: true,
  monthlyBudgetUsd: 10,
  google: { clientId: '', allowedDocIds: [] },
  sync: { onBrowse: true, intervalMinutes: 60 },
  reminders: { enabled: true, leadHours: [48, 24, 3], endOfDaySummary: true, endOfDayHour: 20 },
  captureFixtures: false,
  jarvis: {
    enabled: false,
    transport: 'gateway',
    baseUrl: 'https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev',
    appId: 'school-helper',
    failureStreak: 0,
    droppedTotal: 0,
  },
  schemaVersion: SCHEMA_VERSION,
};

/** Hosts that count as "stays on this machine". */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return (
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '::1' ||
      u.hostname === '0.0.0.0' ||
      u.hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}
