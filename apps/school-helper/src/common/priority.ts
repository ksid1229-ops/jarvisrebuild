import type { WorkItem } from './types';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export interface PriorityBreakdown {
  score: number;
  urgency: number;
  weight: number;
  overdue: number;
  effortLeft: number;
  reason: string;
}

const GRADED_KINDS = new Set(['assignment', 'quiz', 'discussion']);

/**
 * Priority = due date urgency + weight + overdue penalty.
 * Range is roughly 0..100. Higher means do it sooner.
 */
export function priorityOf(item: WorkItem, now = Date.now()): PriorityBreakdown {
  const due = effectiveDue(item);
  const done = isDone(item);

  if (done) {
    return { score: 0, urgency: 0, weight: 0, overdue: 0, effortLeft: 0, reason: 'Done' };
  }

  // Urgency: 45 at/past due, decaying to 0 at 14 days out. No due date => small baseline.
  let urgency = 8;
  if (due != null) {
    const daysLeft = (due - now) / DAY;
    if (daysLeft <= 0) urgency = 45;
    else if (daysLeft >= 14) urgency = 4;
    else urgency = 45 * Math.pow(1 - daysLeft / 14, 1.6);
  }

  // Weight: explicit percent-of-grade wins, else points, else kind heuristic.
  let weight = 0;
  if (item.weight != null) weight = Math.min(30, item.weight * 1.2);
  else if (item.points != null) weight = Math.min(24, Math.sqrt(item.points) * 3);
  else if (GRADED_KINDS.has(item.kind)) weight = 10;
  else weight = 3;

  // Overdue penalty: escalates for the first 10 days, then plateaus.
  let overdue = 0;
  if (due != null && due < now) {
    const daysOver = (now - due) / DAY;
    overdue = 10 + Math.min(15, daysOver * 1.5);
  }

  // Not-started graded work carries a bit more load than half-finished work.
  const effortLeft = item.status === 'not-started' && GRADED_KINDS.has(item.kind) ? 5 : 0;

  const score = Math.round(Math.min(100, urgency + weight + overdue + effortLeft));

  const reason = [
    due == null
      ? 'no due date'
      : due < now
        ? `${Math.floor((now - due) / DAY)}d overdue`
        : `due in ${humanIn(due - now)}`,
    item.weight != null
      ? `${item.weight}% of grade`
      : item.points != null
        ? `${item.points} pts`
        : null,
    item.status === 'not-started' ? 'not started' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return { score, urgency, weight, overdue, effortLeft, reason };
}

export function humanIn(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

export function isDone(item: WorkItem): boolean {
  if (item.completed) return true;
  return item.status === 'submitted' || item.status === 'graded' || item.status === 'returned';
}

/** Manual override on dueAt beats the synced value; otherwise due, else end date. */
export function effectiveDue(item: WorkItem): number | null {
  const o = item.overrides?.dueAt;
  if (o && typeof o.value === 'number') return o.value;
  if (o && o.value === null) return null;
  return item.dueAt ?? item.endAt ?? null;
}

export type Bucket = 'overdue' | 'today' | 'tomorrow' | 'this-week' | 'later' | 'no-date' | 'done';

export function bucketOf(item: WorkItem, now = Date.now()): Bucket {
  if (isDone(item)) return 'done';
  const due = effectiveDue(item);
  if (due == null) return 'no-date';
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + DAY;
  if (due < now) return 'overdue';
  if (due < endOfToday) return 'today';
  if (due < endOfToday + DAY) return 'tomorrow';
  if (due < endOfToday + 7 * DAY) return 'this-week';
  return 'later';
}

export interface PlanSlot {
  label: string;
  items: WorkItem[];
  totalScore: number;
}

/**
 * Weekend plan: spreads the top open work across Sat/Sun, biggest first,
 * balancing the two days by priority load.
 */
export function weekendPlan(items: WorkItem[], now = Date.now(), maxPerDay = 5): PlanSlot[] {
  const open = items
    .filter((i) => !isDone(i))
    .map((i) => ({ item: i, p: priorityOf(i, now).score }))
    .sort((a, b) => b.p - a.p)
    .slice(0, maxPerDay * 2);

  const sat: PlanSlot = { label: 'Saturday', items: [], totalScore: 0 };
  const sun: PlanSlot = { label: 'Sunday', items: [], totalScore: 0 };

  for (const { item, p } of open) {
    const target = sat.totalScore <= sun.totalScore && sat.items.length < maxPerDay ? sat : sun;
    if (target.items.length >= maxPerDay) continue;
    target.items.push(item);
    target.totalScore += p;
  }
  return [sat, sun];
}

/** "What should I do next" — one item, with a short justification. */
export function nextUp(
  items: WorkItem[],
  now = Date.now(),
): { item: WorkItem; why: string } | null {
  const ranked = items
    .filter((i) => !isDone(i))
    .map((i) => ({ i, b: priorityOf(i, now) }))
    .sort((a, b) => b.b.score - a.b.score);
  if (!ranked.length) return null;
  const top = ranked[0];
  return { item: top.i, why: `Priority ${top.b.score}/100 — ${top.b.reason}` };
}
