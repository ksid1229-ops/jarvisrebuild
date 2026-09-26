import type { ChangeRecord, ChangeType, WorkItem } from './types';

/** Fields sync is allowed to write. Everything else is user-owned. */
export const SYNCED_FIELDS = [
  'title',
  'url',
  'description',
  'dueAt',
  'endAt',
  'startAt',
  'points',
  'weight',
  'status',
  'submittedAt',
  'grade',
  'gradeMax',
  'feedback',
  'parentId',
  'sortOrder',
  'hiddenFromList',
  'rubricIds',
  'sources',
] as const;

export type SyncedField = (typeof SYNCED_FIELDS)[number];

/** Fields the user owns outright — sync never touches them. */
export const USER_FIELDS = ['notes', 'tags', 'completed'] as const;

export interface MergeOutcome {
  merged: WorkItem;
  changes: Omit<ChangeRecord, 'id' | 'syncId' | 'seen'>[];
}

const CHANGE_TYPE_BY_FIELD: Partial<Record<SyncedField, ChangeType>> = {
  dueAt: 'due-date',
  endAt: 'due-date',
  grade: 'new-grade',
  feedback: 'new-feedback',
  status: 'status',
};

/**
 * Merge a freshly-scraped item over the stored one.
 *
 * Rules:
 *  1. A manual override on a field always wins and is never overwritten.
 *  2. User-owned fields are preserved untouched.
 *  3. Sync may not blank out a value it simply failed to read (undefined == no news).
 *  4. Every effective change produces a ChangeRecord for the "what changed" view.
 */
export function mergeItem(
  stored: WorkItem | undefined,
  incoming: Partial<WorkItem> &
    Pick<WorkItem, 'id' | 'courseId' | 'board' | 'kind' | 'remoteId' | 'title'>,
  now = Date.now(),
): MergeOutcome {
  const changes: MergeOutcome['changes'] = [];

  if (!stored) {
    const created: WorkItem = {
      status: 'unknown',
      ...incoming,
      overrides: {},
      firstSeenAt: now,
      lastSeenAt: now,
      presentInLastSync: true,
    } as WorkItem;
    changes.push({
      at: now,
      courseId: created.courseId,
      itemId: created.id,
      type: 'new-item',
      title: created.title,
      detail: describeNew(created),
      after: created.dueAt ?? null,
    });
    return { merged: created, changes };
  }

  const merged: WorkItem = { ...stored, lastSeenAt: now, presentInLastSync: true };

  for (const field of SYNCED_FIELDS) {
    const next = (incoming as unknown as Record<string, unknown>)[field];
    if (next === undefined) continue; // sync had nothing to say
    if (stored.overrides?.[field]) continue; // manual edit wins, permanently

    const prev = (stored as unknown as Record<string, unknown>)[field];
    if (equal(prev, next)) continue;

    (merged as unknown as Record<string, unknown>)[field] = next;
    changes.push({
      at: now,
      courseId: merged.courseId,
      itemId: merged.id,
      type: CHANGE_TYPE_BY_FIELD[field] ?? 'other',
      title: merged.title,
      detail: describeChange(field, prev, next),
      before: prev ?? null,
      after: next ?? null,
    });
  }

  return { merged, changes };
}

/** Record a manual edit. Applies the value and pins it against future syncs. */
export function applyOverride<K extends string>(
  item: WorkItem,
  field: K,
  value: unknown,
  now = Date.now(),
): WorkItem {
  const next: WorkItem = { ...item, overrides: { ...(item.overrides ?? {}) } };
  next.overrides![field] = { field, value, editedAt: now };
  (next as unknown as Record<string, unknown>)[field] = value;
  return next;
}

/** Drop a manual edit so sync can own the field again. */
export function clearOverride(item: WorkItem, field: string): WorkItem {
  const overrides = { ...(item.overrides ?? {}) };
  delete overrides[field];
  return { ...item, overrides };
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function fmtDate(v: unknown): string {
  if (v == null) return 'none';
  if (typeof v === 'number')
    return new Date(v).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
  return String(v);
}

function describeNew(item: WorkItem): string {
  const bits = [`New ${item.kind}`];
  if (item.dueAt) bits.push(`due ${fmtDate(item.dueAt)}`);
  if (item.points != null) bits.push(`${item.points} pts`);
  return bits.join(' · ');
}

function describeChange(field: string, prev: unknown, next: unknown): string {
  switch (field) {
    case 'dueAt':
    case 'endAt':
    case 'startAt':
      return `${field === 'dueAt' ? 'Due date' : field === 'endAt' ? 'End date' : 'Start date'}: ${fmtDate(prev)} → ${fmtDate(next)}`;
    case 'grade':
      return `Grade posted: ${next ?? '—'}`;
    case 'feedback':
      return prev ? 'Feedback updated' : 'New feedback posted';
    case 'status':
      return `Status: ${prev ?? 'unknown'} → ${next}`;
    case 'title':
      return `Renamed: "${prev}" → "${next}"`;
    default:
      return `${field} changed`;
  }
}

/** Items that vanished from a sync are flagged, never deleted. */
export function markMissing(stored: WorkItem, now = Date.now()): MergeOutcome {
  if (!stored.presentInLastSync) return { merged: stored, changes: [] };
  return {
    merged: { ...stored, presentInLastSync: false },
    changes: [
      {
        at: now,
        courseId: stored.courseId,
        itemId: stored.id,
        type: 'removed',
        title: stored.title,
        detail: 'No longer listed in D2L (kept locally).',
      },
    ],
  };
}
