import { describe, expect, it } from 'vitest';
import {
  DAY,
  bucketOf,
  effectiveDue,
  nextUp,
  priorityOf,
  weekendPlan,
} from '../src/common/priority';
import { applyOverride } from '../src/common/merge';
import type { WorkItem } from '../src/common/types';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const item = (patch: Partial<WorkItem>): WorkItem => ({
  id: Math.random().toString(36),
  courseId: 'c',
  board: 'ldsb',
  kind: 'assignment',
  remoteId: 'r',
  title: 't',
  status: 'not-started',
  firstSeenAt: 0,
  lastSeenAt: 0,
  presentInLastSync: true,
  ...patch,
});

describe('priority score', () => {
  it('scores overdue work above work due next week', () => {
    const overdue = priorityOf(item({ dueAt: NOW - 3 * DAY }), NOW).score;
    const soon = priorityOf(item({ dueAt: NOW + 7 * DAY }), NOW).score;
    expect(overdue).toBeGreaterThan(soon);
  });

  it('weights heavier assessments higher at the same due date', () => {
    const heavy = priorityOf(item({ dueAt: NOW + 2 * DAY, weight: 20 }), NOW).score;
    const light = priorityOf(item({ dueAt: NOW + 2 * DAY, weight: 2 }), NOW).score;
    expect(heavy).toBeGreaterThan(light);
  });

  it('escalates with how long something has been overdue, then plateaus', () => {
    const a = priorityOf(item({ dueAt: NOW - 1 * DAY }), NOW).score;
    const b = priorityOf(item({ dueAt: NOW - 8 * DAY }), NOW).score;
    const c = priorityOf(item({ dueAt: NOW - 60 * DAY }), NOW).score;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeLessThanOrEqual(100);
    expect(c).toBeGreaterThanOrEqual(b);
  });

  it('scores done work at zero', () => {
    expect(priorityOf(item({ dueAt: NOW - 10 * DAY, status: 'graded' }), NOW).score).toBe(0);
    expect(priorityOf(item({ dueAt: NOW - 10 * DAY, completed: true }), NOW).score).toBe(0);
  });

  it('never exceeds 100', () => {
    expect(
      priorityOf(item({ dueAt: NOW - 90 * DAY, weight: 40, points: 100 }), NOW).score,
    ).toBeLessThanOrEqual(100);
  });
});

describe('buckets', () => {
  it('sorts items into overdue / today / tomorrow / this week', () => {
    expect(bucketOf(item({ dueAt: NOW - DAY }), NOW)).toBe('overdue');
    expect(bucketOf(item({ dueAt: NOW + 60_000 }), NOW)).toBe('today');
    expect(bucketOf(item({ dueAt: NOW + 1.2 * DAY }), NOW)).toBe('tomorrow');
    expect(bucketOf(item({ dueAt: NOW + 4 * DAY }), NOW)).toBe('this-week');
    expect(bucketOf(item({ dueAt: NOW + 30 * DAY }), NOW)).toBe('later');
    expect(bucketOf(item({}), NOW)).toBe('no-date');
    expect(bucketOf(item({ completed: true }), NOW)).toBe('done');
  });
});

describe('effective due date', () => {
  it('prefers a manual override over the synced date', () => {
    const pinned = applyOverride(item({ dueAt: NOW }), 'dueAt', NOW + 5 * DAY);
    expect(effectiveDue(pinned)).toBe(NOW + 5 * DAY);
  });
  it('falls back to the end date when there is no due date', () => {
    expect(effectiveDue(item({ endAt: NOW + DAY }))).toBe(NOW + DAY);
  });
});

describe('planning helpers', () => {
  const items = [
    item({ title: 'a', dueAt: NOW - 2 * DAY, weight: 15 }),
    item({ title: 'b', dueAt: NOW + DAY, weight: 10 }),
    item({ title: 'c', dueAt: NOW + 3 * DAY }),
    item({ title: 'd', status: 'graded', dueAt: NOW - DAY }),
  ];

  it('picks the highest-priority open item for "what next"', () => {
    expect(nextUp(items, NOW)!.item.title).toBe('a');
  });

  it('balances the weekend plan across two days and skips done work', () => {
    const [sat, sun] = weekendPlan(items, NOW);
    const titles = [...sat.items, ...sun.items].map((i) => i.title);
    expect(titles).not.toContain('d');
    expect(Math.abs(sat.totalScore - sun.totalScore)).toBeLessThan(80);
  });
});

describe('deadline tiles', () => {
  it('buckets lessons by availability, never as due — even past their end date', () => {
    const lesson = item({ kind: 'lesson', dueAt: null, endAt: NOW - DAY });
    expect(bucketOf(lesson, NOW)).toBe('no-date');
    expect(priorityOf(lesson, NOW).reason).toContain('no due date');
  });

  it('still buckets assignments and quizzes by their due dates', () => {
    expect(bucketOf(item({ kind: 'assignment', dueAt: NOW - 1000 }), NOW)).toBe('overdue');
    expect(bucketOf(item({ kind: 'quiz', dueAt: NOW - 1000 }), NOW)).toBe('overdue');
    expect(bucketOf(item({ kind: 'assignment', dueAt: NOW + DAY }), NOW)).toBe('tomorrow');
  });
});
