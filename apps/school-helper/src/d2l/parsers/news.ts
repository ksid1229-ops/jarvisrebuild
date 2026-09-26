import type { BoardId, WorkItem } from '../../common/types';
import { extractSources, parseD2lDate, richTextToPlain, type RichText } from './common';

export interface D2lNewsItem {
  Id: number | string;
  Title: string;
  Body?: RichText | null;
  StartDate?: string | null;
  EndDate?: string | null;
  IsGlobal?: boolean;
  IsPublished?: boolean;
  ShowOnlyInCourseOfferings?: boolean;
  Attachments?: { FileId: number; FileName: string }[];
  IsAuthorInfoShown?: boolean;
}

export interface NewsParseCtx {
  courseId: string;
  board: BoardId;
  origin: string;
  orgUnitId: string;
  now?: number;
}

/** Announcements are read-only; the extension never marks one as read. */
export function parseAnnouncements(news: D2lNewsItem[], ctx: NewsParseCtx): WorkItem[] {
  const now = ctx.now ?? Date.now();
  return (news ?? [])
    .filter((n) => n.IsPublished !== false)
    .map((n) => {
      const remoteId = String(n.Id);
      const sources = extractSources(n.Body?.Html ?? null, ctx.origin);
      return {
        id: `${ctx.courseId}:announcement:${remoteId}`,
        courseId: ctx.courseId,
        board: ctx.board,
        kind: 'announcement' as const,
        remoteId,
        title: n.Title?.trim() || '(untitled announcement)',
        url: `${ctx.origin}/d2l/le/news/${ctx.orgUnitId}/${remoteId}/view`,
        description: richTextToPlain(n.Body) || undefined,
        startAt: parseD2lDate(n.StartDate),
        endAt: parseD2lDate(n.EndDate),
        dueAt: null,
        status: 'unknown' as const,
        sources: sources.length ? sources : undefined,
        firstSeenAt: now,
        lastSeenAt: now,
        presentInLastSync: true,
      };
    });
}
