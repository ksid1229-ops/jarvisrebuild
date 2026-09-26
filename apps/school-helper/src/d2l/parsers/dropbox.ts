import type { BoardId, SubmissionStatus, WorkItem } from '../../common/types';
import { extractSources, parseD2lDate, richTextToPlain, type RichText } from './common';

export interface D2lDropboxFolder {
  Id: number | string;
  CategoryId?: number | null;
  Name: string;
  CustomInstructions?: RichText | null;
  Attachments?: { FileId: number; FileName: string; Size?: number }[];
  TotalFiles?: number;
  UnreadFiles?: number;
  FlaggedFiles?: number;
  TotalUsers?: number;
  TotalUsersWithSubmissions?: number;
  TotalUsersWithFeedback?: number;
  DueDate?: string | null;
  DisplayInCalendar?: boolean;
  Availability?: { StartDate?: string | null; EndDate?: string | null } | null;
  GroupTypeId?: number | null;
  IsHidden?: boolean;
  Assessment?: {
    ScoreDenominator?: number | null;
    Rubrics?: { RubricId: number; Name?: string }[];
  } | null;
  GradeItemId?: number | null;
  ActivityId?: string | null;
}

/** GET /dropbox/folders/{id}/submissions/ — entity list, one per student or group. */
export interface D2lSubmissionEntity {
  Entity?: { EntityId?: number; EntityType?: string; Active?: boolean; DisplayName?: string };
  Status?: number; // 0 unsubmitted, 1 submitted, 2 draft, 3 published/graded
  Feedback?: {
    Score?: number | null;
    Feedback?: RichText | null;
    RubricAssessments?: unknown[];
    IsGraded?: boolean;
    GradedSymbol?: string | null;
    GradedDate?: string | null;
  } | null;
  Submissions?: {
    Id: number;
    SubmittedBy?: { Identifier?: string; DisplayName?: string };
    SubmissionDate?: string | null;
    Comment?: RichText | null;
    Files?: {
      FileId: number;
      FileName: string;
      Size?: number;
      IsFlagged?: boolean;
      IsRead?: boolean;
    }[];
  }[];
  CompletionDate?: string | null;
}

export interface DropboxParseCtx {
  courseId: string;
  board: BoardId;
  origin: string;
  orgUnitId: string;
  now?: number;
  /** Ids seen linked from content; used to flag folders hidden from the list page. */
  linkedFromContent?: Set<string>;
}

export function parseDropboxFolder(folder: D2lDropboxFolder, ctx: DropboxParseCtx): WorkItem {
  const now = ctx.now ?? Date.now();
  const remoteId = String(folder.Id);
  const instructionsHtml = folder.CustomInstructions?.Html ?? null;
  const sources = extractSources(instructionsHtml, ctx.origin);

  return {
    id: `${ctx.courseId}:assignment:${remoteId}`,
    courseId: ctx.courseId,
    board: ctx.board,
    kind: 'assignment',
    remoteId,
    title: folder.Name?.trim() || '(untitled assignment)',
    url: `${ctx.origin}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${remoteId}&ou=${ctx.orgUnitId}`,
    description: richTextToPlain(folder.CustomInstructions) || undefined,
    dueAt: parseD2lDate(folder.DueDate),
    startAt: parseD2lDate(folder.Availability?.StartDate),
    endAt: parseD2lDate(folder.Availability?.EndDate),
    points: folder.Assessment?.ScoreDenominator ?? null,
    status: 'not-started',
    hiddenFromList:
      folder.IsHidden === true || ctx.linkedFromContent?.has(remoteId) === true
        ? folder.IsHidden === true
        : undefined,
    rubricIds: folder.Assessment?.Rubrics?.length
      ? folder.Assessment.Rubrics.map((r) => String(r.RubricId))
      : undefined,
    sources: sources.length ? sources : undefined,
    firstSeenAt: now,
    lastSeenAt: now,
    presentInLastSync: true,
  };
}

/** Map D2L's numeric submission status onto ours. */
export function submissionStatusOf(entity: D2lSubmissionEntity): SubmissionStatus {
  const graded = entity.Feedback?.IsGraded === true || entity.Feedback?.Score != null;
  if (graded) return 'graded';
  const hasFiles = (entity.Submissions ?? []).some(
    (s) => (s.Files?.length ?? 0) > 0 || !!s.SubmissionDate,
  );
  switch (entity.Status) {
    case 3:
      return 'returned';
    case 2:
      return 'in-progress';
    case 1:
      return 'submitted';
    case 0:
      return hasFiles ? 'submitted' : 'not-started';
    default:
      return hasFiles ? 'submitted' : 'unknown';
  }
}

/**
 * Fold the signed-in student's submission record into the assignment item.
 * `myUserId` filters group/class lists down to the one row that is ours.
 */
export function applySubmission(
  item: WorkItem,
  entities: D2lSubmissionEntity[],
  myUserId?: string,
): WorkItem {
  const mine =
    entities.find((e) => myUserId && String(e.Entity?.EntityId ?? '') === String(myUserId)) ??
    (entities.length === 1 ? entities[0] : undefined);
  if (!mine) return item;

  const submissionDates = (mine.Submissions ?? [])
    .map((s) => parseD2lDate(s.SubmissionDate))
    .filter((d): d is number => d != null);

  const feedbackText = richTextToPlain(mine.Feedback?.Feedback);

  return {
    ...item,
    status: submissionStatusOf(mine),
    submittedAt: submissionDates.length ? Math.max(...submissionDates) : null,
    grade: mine.Feedback?.Score ?? null,
    gradeMax: item.points ?? null,
    feedback: feedbackText || null,
  };
}

/**
 * Folders linked from content but absent from /dropbox/folders/ are the
 * "hidden from the list" case. Fetch each by id and mark it.
 */
export function findHiddenFolderIds(
  listedFolders: D2lDropboxFolder[],
  linkedFromContent: { kind: string; remoteId: string }[],
): string[] {
  const listed = new Set(listedFolders.map((f) => String(f.Id)));
  const out = new Set<string>();
  for (const link of linkedFromContent) {
    if (link.kind !== 'assignment') continue;
    if (!listed.has(link.remoteId)) out.add(link.remoteId);
  }
  return [...out];
}
