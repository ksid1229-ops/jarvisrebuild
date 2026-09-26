import type { BoardId, WorkItem } from '../../common/types';
import { parseD2lDate, richTextToPlain, type RichText } from './common';

export interface D2lForum {
  ForumId: number | string;
  Name: string;
  Description?: RichText | null;
  StartDate?: string | null;
  EndDate?: string | null;
  IsHidden?: boolean;
  SortOrder?: number;
}

export interface D2lDiscussionTopic {
  ForumId: number | string;
  TopicId: number | string;
  Name: string;
  Description?: RichText | null;
  StartDate?: string | null;
  EndDate?: string | null;
  UnreadPostCount?: number;
  PostCount?: number;
  IsHidden?: boolean;
  ScoreOutOf?: number | null;
  GradeItemId?: number | null;
  RequiresApproval?: boolean;
  SortOrder?: number;
}

export interface DiscussionParseCtx {
  courseId: string;
  board: BoardId;
  origin: string;
  orgUnitId: string;
  now?: number;
}

/** Reading discussions never marks posts as read — we only GET the listing. */
export function parseDiscussionTopic(
  topic: D2lDiscussionTopic,
  forum: D2lForum | undefined,
  ctx: DiscussionParseCtx,
): WorkItem {
  const now = ctx.now ?? Date.now();
  const remoteId = String(topic.TopicId);
  const forumName = forum?.Name ? `${forum.Name} — ` : '';
  return {
    id: `${ctx.courseId}:discussion:${remoteId}`,
    courseId: ctx.courseId,
    board: ctx.board,
    kind: 'discussion',
    remoteId,
    title: `${forumName}${topic.Name?.trim() || '(untitled topic)'}`,
    url: `${ctx.origin}/d2l/le/${ctx.orgUnitId}/discussions/topics/${remoteId}/View`,
    description: richTextToPlain(topic.Description) || undefined,
    startAt: parseD2lDate(topic.StartDate ?? forum?.StartDate),
    endAt: parseD2lDate(topic.EndDate ?? forum?.EndDate),
    dueAt: parseD2lDate(topic.EndDate),
    points: topic.ScoreOutOf ?? null,
    sortOrder: topic.SortOrder,
    status: (topic.PostCount ?? 0) > 0 ? 'unknown' : 'not-started',
    firstSeenAt: now,
    lastSeenAt: now,
    presentInLastSync: true,
  };
}

export function parseDiscussions(
  forums: D2lForum[],
  topicsByForum: Record<string, D2lDiscussionTopic[]>,
  ctx: DiscussionParseCtx,
): WorkItem[] {
  const out: WorkItem[] = [];
  for (const forum of forums ?? []) {
    if (forum.IsHidden) continue;
    const topics = topicsByForum[String(forum.ForumId)] ?? [];
    for (const topic of topics) {
      if (topic.IsHidden) continue;
      out.push(parseDiscussionTopic(topic, forum, ctx));
    }
  }
  return out;
}
