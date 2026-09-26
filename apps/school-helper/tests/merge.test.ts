import { describe, expect, it } from 'vitest';
import { applyOverride, clearOverride, markMissing, mergeItem } from '../src/common/merge';
import type { WorkItem } from '../src/common/types';

const base = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: 'c:assignment:1',
  courseId: 'c',
  board: 'ldsb',
  kind: 'assignment',
  remoteId: '1',
  title: 'Worksheet',
  status: 'not-started',
  dueAt: Date.parse('2026-09-19T03:59:00.000Z'),
  firstSeenAt: 1,
  lastSeenAt: 1,
  presentInLastSync: true,
  ...patch,
});

describe('sync merge', () => {
  it('creates a new item and reports it as a change', () => {
    const { merged, changes } = mergeItem(undefined, base(), 100);
    expect(merged.firstSeenAt).toBe(100);
    expect(changes[0].type).toBe('new-item');
  });

  it('reports a due-date change with before and after', () => {
    const stored = base();
    const next = Date.parse('2026-09-26T03:59:00.000Z');
    const { merged, changes } = mergeItem(stored, { ...base(), dueAt: next }, 200);
    expect(merged.dueAt).toBe(next);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('due-date');
    expect(changes[0].after).toBe(next);
  });

  it('reports new grades and new feedback separately', () => {
    const stored = base({ status: 'submitted' });
    const { changes } = mergeItem(
      stored,
      { ...base(), grade: 17, feedback: 'Nice work', status: 'graded' },
      300,
    );
    const types = changes.map((c) => c.type).sort();
    expect(types).toEqual(['new-feedback', 'new-grade', 'status']);
  });

  it('MANUAL EDITS SURVIVE SYNC — a pinned due date is never overwritten', () => {
    const pinned = applyOverride(base(), 'dueAt', Date.parse('2026-10-01T03:59:00.000Z'));
    const { merged, changes } = mergeItem(
      pinned,
      { ...base(), dueAt: Date.parse('2026-09-05T03:59:00.000Z') },
      400,
    );
    expect(merged.dueAt).toBe(Date.parse('2026-10-01T03:59:00.000Z'));
    expect(changes).toHaveLength(0);
  });

  it('a pinned field can be released so sync owns it again', () => {
    const pinned = applyOverride(base(), 'status', 'in-progress');
    const released = clearOverride(pinned, 'status');
    const { merged } = mergeItem(released, { ...base(), status: 'graded' }, 500);
    expect(merged.status).toBe('graded');
  });

  it('never lets sync blank a field it simply failed to read', () => {
    const stored = base({ grade: 17, feedback: 'Good' });
    const { merged } = mergeItem(
      stored,
      {
        id: stored.id,
        courseId: 'c',
        board: 'ldsb',
        kind: 'assignment',
        remoteId: '1',
        title: 'Worksheet',
      },
      600,
    );
    expect(merged.grade).toBe(17);
    expect(merged.feedback).toBe('Good');
  });

  it('preserves user-owned fields (notes, tags, completed)', () => {
    const stored = base({ notes: 'ask Ms. Pardy', tags: ['priority'], completed: true });
    const { merged } = mergeItem(stored, { ...base(), title: 'Worksheet v2' }, 700);
    expect(merged.notes).toBe('ask Ms. Pardy');
    expect(merged.tags).toEqual(['priority']);
    expect(merged.completed).toBe(true);
  });

  it('flags missing items instead of deleting them', () => {
    const { merged, changes } = markMissing(base(), 800);
    expect(merged.presentInLastSync).toBe(false);
    expect(changes[0].type).toBe('removed');
    expect(markMissing(merged, 900).changes).toHaveLength(0);
  });
});
