/**
 * MV3 service worker.
 *
 * Responsibilities:
 *  - opens the dashboard tab from the toolbar icon
 *  - opens the side panel on D2L and Google Docs pages
 *  - runs syncs (manual, on-browse, on a periodic alarm)
 *  - fires due-date reminders and the end-of-day summary
 *
 * All D2L reads happen here, in the extension origin, with host permissions —
 * so a D2L page's own CSP can never interfere, and no page script can see the
 * data. Every request is a GET (enforced in D2lClient).
 */

import { db, getSettings } from '../common/db';
import type { Message, SyncStatus } from '../common/messaging';
import { BOARDS } from '../common/settings';
import type { BoardId } from '../common/types';
import { runSync, summariseChanges } from '../d2l/sync';
import { exportFixtures } from '../d2l/capture';
import { D2lClient } from '../d2l/client';
import { ensureDurhamSession } from '../d2l/sso';
import { pushEvidence } from '../jarvis/push';
import {
  checkPairing,
  flushOutboxNow,
  jarvisSettings,
  log as logJarvis,
  makeTransport,
  startPairing,
} from '../jarvis/link';
import { pullAndExecute, type PullOutcome } from '../jarvis/pull';
import {
  DAY_SUMMARY_ALARM,
  SYNC_ALARM,
  fireDaySummary,
  fireReminder,
  isReminderAlarm,
  notifySyncResult,
  rescheduleReminders,
} from './notifications';

const DASHBOARD_URL = 'dashboard.html';
const D2L_HOSTS = ['ldsb.elearningontario.ca', 'durham.elearningontario.ca'];

let status: SyncStatus = { running: false, message: 'Idle', pct: 0 };
let lastBrowseSync = 0;
const BROWSE_SYNC_COOLDOWN = 10 * 60_000;

chrome.runtime.onInstalled.addListener(async (details) => {
  await getSettings(); // materialise defaults
  await rescheduleReminders();
  await chrome.alarms.create(JARVIS_PULL_ALARM, { periodInMinutes: 2 });
  if (details.reason === 'install') {
    await openDashboard('#/welcome');
  }
});

chrome.runtime.onStartup.addListener(() => {
  void rescheduleReminders();
  void chrome.alarms.create(JARVIS_PULL_ALARM, { periodInMinutes: 2 });
});

chrome.action.onClicked.addListener(() => {
  void openDashboard();
});

/** Side panel opens automatically on D2L and Google Docs. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  const url = safeUrl(tab.url);
  if (!url) return;

  const onD2l = D2L_HOSTS.includes(url.hostname);
  const onDocs = url.hostname === 'docs.google.com' && url.pathname.includes('/document/');

  if (chrome.sidePanel && (onD2l || onDocs)) {
    try {
      await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    } catch {}
  }

  if (onD2l) void maybeBrowseSync();
});

async function maybeBrowseSync(): Promise<void> {
  const settings = await getSettings();
  if (!settings.sync.onBrowse) return;
  if (status.running) return;
  if (Date.now() - lastBrowseSync < BROWSE_SYNC_COOLDOWN) return;
  lastBrowseSync = Date.now();
  void doSync({ trigger: 'browse' });
}

const JARVIS_ALARM = 'jarvis-flush';
const JARVIS_PULL_ALARM = 'jarvis-pull';

/**
 * Sends evidence to Jarvis. Always best-effort: a link failure must never turn
 * a successful school sync into a failed one, so it is caught and logged.
 */
async function pushToJarvis(): Promise<void> {
  try {
    const settings = await jarvisSettings();
    if (!settings.enabled) return;
    await pushEvidence({
      ensureDurham: async () => {
        await ensureDurhamSession(new D2lClient('ldsb'), new D2lClient('durham'));
      },
    });
  } catch (err) {
    console.warn('[jarvis] push failed', (err as Error).message);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === JARVIS_ALARM) {
    // Retry anything the last push could not deliver, on the existing cadence.
    await flushOutboxNow().catch(() => undefined);
    return;
  }
  if (alarm.name === JARVIS_PULL_ALARM) {
    await pullFromJarvis();
    return;
  }
  if (alarm.name === SYNC_ALARM) {
    await doSync({ trigger: 'alarm' });
    return;
  }
  if (alarm.name === DAY_SUMMARY_ALARM) {
    await fireDaySummary();
    return;
  }
  if (isReminderAlarm(alarm.name)) {
    await fireReminder(alarm.name);
  }
});

chrome.notifications.onClicked.addListener((id) => {
  const parts = id.split(':');
  const context = parts[1];
  void openDashboard(context === 'sync' ? '#/changes' : '#/today');
});

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  handle(msg)
    .then((res) => sendResponse({ ok: true, data: res }))
    .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
  return true; // async
});

async function handle(msg: Message): Promise<unknown> {
  switch (msg.type) {
    case 'sync:start':
      return doSync({ trigger: msg.trigger, boards: msg.boards, courseIds: msg.courseIds });
    case 'sync:status':
      return status;
    case 'open:dashboard':
      return openDashboard(msg.route);
    case 'reminders:reschedule':
      return { scheduled: await rescheduleReminders() };
    case 'day-summary:now':
      return fireDaySummary();
    case 'jarvis:pair':
      return startPairing(msg.deviceLabel);
    case 'jarvis:check':
      return checkPairing();
    case 'jarvis:flush':
      return flushOutboxNow();
    case 'jarvis:push':
      return pushToJarvis();
    case 'jarvis:pull':
      return pullFromJarvis();
    case 'fixtures:export':
      return exportFixtures();
    case 'notify:test':
      return chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'School Helper',
        message: 'Notifications are working.',
      });
    default:
      return null;
  }
}

/**
 * Collects Jarvis's queued requests (sync_now, open_item). Best-effort like
 * the push: a pull failure is logged, never thrown into the alarm handler.
 * Returns null when the link is off or unpaired.
 */
async function pullFromJarvis(): Promise<PullOutcome | null> {
  try {
    const settings = await jarvisSettings();
    if (!settings.enabled || settings.pairing?.status !== 'active') return null;
    return await pullAndExecute({
      transport: () => makeTransport(),
      isLinked: async () => true,
      runSync: () => doSync({ trigger: 'alarm' }),
      openUrl: async (url) => {
        await chrome.tabs.create({ url });
      },
      allowedOrigins: [BOARDS.ldsb.origin, BOARDS.durham.origin],
      log: async (entry) => {
        await logJarvis({
          endpoint: entry.endpoint,
          method: 'POST',
          status: 200,
          ok: entry.ok,
          itemCount: 0,
          detail: entry.detail,
        });
      },
    });
  } catch (err) {
    console.warn('[jarvis] pull failed', (err as Error).message);
    return null;
  }
}

async function doSync(opts: {
  trigger: 'manual' | 'browse' | 'alarm';
  boards?: BoardId[];
  courseIds?: string[];
}): Promise<SyncStatus> {
  if (status.running) return status;
  status = { running: true, message: 'Starting…', pct: 0, lastRun: status.lastRun };

  try {
    const { run, changes } = await runSync({
      trigger: opts.trigger,
      boards: opts.boards,
      courseIds: opts.courseIds,
      onProgress: (message, pct) => {
        status = { ...status, message, pct };
        chrome.runtime.sendMessage({ type: 'sync:progress', message, pct }).catch(() => {});
      },
    });

    status = {
      running: false,
      message: run.ok ? 'Up to date' : 'Finished with errors',
      pct: 100,
      lastRun: run,
    };
    chrome.runtime.sendMessage({ type: 'sync:done', run, changes }).catch(() => {});

    await notifySyncResult(changes.length, summariseChanges(changes));
    await rescheduleReminders();
    await updateBadge();
    // The Jarvis link runs after School Helper's own sync and never blocks it.
    await pushToJarvis();
    return status;
  } catch (err) {
    const error = (err as Error).message;
    status = { running: false, message: `Sync failed: ${error}`, pct: 0, lastRun: status.lastRun };
    chrome.runtime.sendMessage({ type: 'sync:error', error }).catch(() => {});
    return status;
  }
}

/** Badge shows the count of unseen changes. */
async function updateBadge(): Promise<void> {
  const unseen = await db.changes
    .where('seen')
    .equals(0)
    .count()
    .catch(async () => {
      const all = await db.changes.toArray();
      return all.filter((c) => !c.seen).length;
    });
  await chrome.action.setBadgeText({ text: unseen ? String(Math.min(99, unseen)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}

async function openDashboard(route = '#/today'): Promise<void> {
  const url = chrome.runtime.getURL(`${DASHBOARD_URL}${route}`);
  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL(`${DASHBOARD_URL}*`) });
  if (existing.length && existing[0].id != null) {
    await chrome.tabs.update(existing[0].id, { active: true, url });
    if (existing[0].windowId != null)
      await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}
