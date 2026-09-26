import type { BoardId, WorkItem } from '../../common/types';
import { parseD2lDate, richTextToPlain, type RichText } from './common';

export interface D2lQuiz {
  QuizId: number | string;
  Name: string;
  IsActive?: boolean;
  SortOrder?: number;
  AutoExportToGrades?: boolean;
  GradeItemId?: number | null;
  IsAutoSetGraded?: boolean;
  Instructions?: { Text?: RichText | null; IsDisplayed?: boolean } | null;
  Description?: { Text?: RichText | null; IsDisplayed?: boolean } | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  DisplayInCalendar?: boolean;
  AttemptsAllowed?: { IsUnlimited?: boolean; NumberOfAttemptsAllowed?: number } | null;
  ActivityId?: string | null;
  CategoryId?: number | null;
}

export interface QuizParseCtx {
  courseId: string;
  board: BoardId;
  origin: string;
  orgUnitId: string;
  now?: number;
}

/**
 * Quizzes are listed for awareness only. The extension never opens an attempt,
 * never reads questions, and never submits — see endpoints.assertSafePath.
 */
export function parseQuiz(quiz: D2lQuiz, ctx: QuizParseCtx): WorkItem {
  const now = ctx.now ?? Date.now();
  const remoteId = String(quiz.QuizId);
  return {
    id: `${ctx.courseId}:quiz:${remoteId}`,
    courseId: ctx.courseId,
    board: ctx.board,
    kind: 'quiz',
    remoteId,
    title: quiz.Name?.trim() || '(untitled quiz)',
    url: `${ctx.origin}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${remoteId}&ou=${ctx.orgUnitId}`,
    description: richTextToPlain(quiz.Description?.Text ?? quiz.Instructions?.Text) || undefined,
    dueAt: parseD2lDate(quiz.DueDate),
    startAt: parseD2lDate(quiz.StartDate),
    endAt: parseD2lDate(quiz.EndDate),
    sortOrder: quiz.SortOrder,
    status: 'unknown',
    firstSeenAt: now,
    lastSeenAt: now,
    presentInLastSync: true,
  };
}

export function parseQuizzes(quizzes: D2lQuiz[], ctx: QuizParseCtx): WorkItem[] {
  return (quizzes ?? []).filter((q) => q.IsActive !== false).map((q) => parseQuiz(q, ctx));
}
