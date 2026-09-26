import { db, getSettings } from '../common/db';
import { bucketOf, effectiveDue, isDone, priorityOf } from '../common/priority';
import { buildDaySummary } from '../ai/helpers';
import type { WorkItem } from '../common/types';

const REMINDER_PREFIX = 'school-helper:due:';
export const DAY_SUMMARY_ALARM = 'school-helper:day-summary';
export const SYNC_ALARM = 'school-helper:sync';

/** Rebuild every due-date alarm from the current item list. */
export async function rescheduleReminders(): Promise<number> {
  const settings = await getSettings();
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing
      .filter((a) => a.name.startsWith(REMINDER_PREFIX))
      .map((a) => chrome.alarms.clear(a.name)),
  );
  if (!settings.reminders.enabled) return 0;

  const items = await db.items.toArray();
  const now = Date.now();
  let scheduled = 0;

  for (const item of items) {
    if (isDone(item)) continue;
    const due = effectiveDue(item);
    if (due == null || due < now) continue;
    for (const lead of settings.reminders.leadHours) {
      const when = due - lead * 3_600_000;
      if (when <= now) continue;
      await chrome.alarms.create(`${REMINDER_PREFIX}${item.id}:${lead}`, { when });
      scheduled++;
    }
  }

  // Periodic background sync.
  await chrome.alarms.clear(SYNC_ALARM);
  if (settings.sync.intervalMinutes > 0) {
    await chrome.alarms.create(SYNC_ALARM, {
      periodInMinutes: Math.max(15, settings.sync.intervalMinutes),
    });
  }

  // End-of-day summary.
  await chrome.alarms.clear(DAY_SUMMARY_ALARM);
  if (settings.reminders.endOfDaySummary) {
    const next = new Date();
    next.setHours(settings.reminders.endOfDayHour, 0, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    await chrome.alarms.create(DAY_SUMMARY_ALARM, {
      when: next.getTime(),
      periodInMinutes: 24 * 60,
    });
  }

  return scheduled;
}

export function isReminderAlarm(name: string): boolean {
  return name.startsWith(REMINDER_PREFIX);
}

export async function fireReminder(alarmName: string): Promise<void> {
  const rest = alarmName.slice(REMINDER_PREFIX.length);
  const lastColon = rest.lastIndexOf(':');
  const itemId = rest.slice(0, lastColon);
  const lead = Number(rest.slice(lastColon + 1));

  const item = await db.items.get(itemId);
  if (!item || isDone(item)) return;
  const course = await db.courses.get(item.courseId);
  const due = effectiveDue(item);

  await notify(
    `${course?.code ?? 'School'} — due in ${lead}h`,
    `${item.title}\n${due ? new Date(due).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : ''}`,
    itemId,
  );
}

export async function fireDaySummary(): Promise<void> {
  const [items, courses] = await Promise.all([db.items.toArray(), db.courses.toArray()]);
  const open = items.filter(
    (i) => !isDone(i) && bucketOf(i) !== 'later' && bucketOf(i) !== 'no-date',
  );
  if (!open.length) {
    await notify(
      'Nothing outstanding',
      'No overdue or upcoming work. Enjoy the evening.',
      'day-summary',
    );
    return;
  }
  const summary = buildDaySummary(items, courses);
  const top = open.sort((a, b) => priorityOf(b).score - priorityOf(a).score).slice(0, 3);
  await notify(
    `End of day — ${open.length} item${open.length === 1 ? '' : 's'} on deck`,
    top.map((i: WorkItem) => `• ${i.title}`).join('\n'),
    'day-summary',
  );
  await chrome.storage.local.set({ 'school-helper.last-day-summary': { at: Date.now(), summary } });
}

export async function notifySyncResult(changeCount: number, summary: string): Promise<void> {
  if (changeCount === 0) return;
  await notify(`Sync: ${changeCount} change${changeCount === 1 ? '' : 's'}`, summary, 'sync');
}

export async function notify(title: string, message: string, context: string): Promise<void> {
  try {
    await chrome.notifications.create(`school-helper:${context}:${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: message.slice(0, 500),
      priority: 1,
    });
  } catch {
    // Notifications can be blocked at the OS level; never let that break a sync.
  }
}
