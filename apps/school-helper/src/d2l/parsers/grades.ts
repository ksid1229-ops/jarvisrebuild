import type { WorkItem } from '../../common/types';
import { parseD2lDate, richTextToPlain, type RichText } from './common';

export interface D2lGradeObject {
  Id: number | string;
  Name: string;
  ShortName?: string;
  GradeType?: string; // 'Numeric' | 'PassFail' | 'SelectBox' | 'Text'
  CategoryId?: number | null;
  MaxPoints?: number | null;
  Weight?: number | null;
  IsBonus?: boolean;
  ExcludeFromFinalGradeCalculation?: boolean;
  AssociatedTool?: { ToolId?: number; ToolItemId?: number } | null;
}

export interface D2lGradeValue {
  DisplayedGrade?: string | null;
  GradeObjectIdentifier: string;
  GradeObjectName?: string;
  GradeObjectType?: number;
  GradeObjectTypeName?: string;
  PointsNumerator?: number | null;
  PointsDenominator?: number | null;
  WeightedNumerator?: number | null;
  WeightedDenominator?: number | null;
  Comments?: RichText | null;
  PrivateComments?: RichText | null;
  LastModified?: string | null;
}

export interface GradeIndex {
  /** By grade object id. */
  byId: Map<string, D2lGradeValue>;
  /** By the tool item it is attached to (dropbox/quiz/discussion id). */
  byToolItem: Map<string, D2lGradeValue>;
  /** Percent weight per grade object, from the grade book. */
  weightById: Map<string, number>;
}

export function indexGrades(objects: D2lGradeObject[], values: D2lGradeValue[]): GradeIndex {
  const byId = new Map<string, D2lGradeValue>();
  const byToolItem = new Map<string, D2lGradeValue>();
  const weightById = new Map<string, number>();

  for (const v of values) byId.set(String(v.GradeObjectIdentifier), v);

  for (const o of objects) {
    const id = String(o.Id);
    if (o.Weight != null) weightById.set(id, o.Weight);
    const toolItemId = o.AssociatedTool?.ToolItemId;
    const value = byId.get(id);
    if (toolItemId != null && value) byToolItem.set(String(toolItemId), value);
  }
  return { byId, byToolItem, weightById };
}

/** Attach grade, feedback and weight to items that have a matching grade object. */
export function applyGrades(
  items: WorkItem[],
  index: GradeIndex,
  objects: D2lGradeObject[],
): WorkItem[] {
  const weightByToolItem = new Map<string, number>();
  for (const o of objects) {
    const toolItemId = o.AssociatedTool?.ToolItemId;
    if (toolItemId != null && o.Weight != null) weightByToolItem.set(String(toolItemId), o.Weight);
  }

  return items.map((item) => {
    const value = index.byToolItem.get(item.remoteId);
    const weight = weightByToolItem.get(item.remoteId);
    if (!value && weight == null) return item;

    const comments = richTextToPlain(value?.Comments);
    const next: WorkItem = { ...item };
    if (weight != null) next.weight = weight;
    if (value) {
      if (value.PointsNumerator != null) next.grade = value.PointsNumerator;
      if (value.PointsDenominator != null) next.gradeMax = value.PointsDenominator;
      // Dropbox feedback is richer than a gradebook comment; never overwrite it.
      if (comments && !next.feedback) next.feedback = comments;
      if (value.PointsNumerator != null && item.status !== 'returned') next.status = 'graded';
    }
    return next;
  });
}

/** Overall course mark, if the gradebook exposes a final calculated value. */
export function finalGrade(values: D2lGradeValue[]): {
  percent: number | null;
  display: string | null;
} {
  const final = values.find(
    (v) => /final/i.test(v.GradeObjectName ?? '') || v.GradeObjectTypeName === 'FinalGrade',
  );
  if (!final) return { percent: null, display: null };
  const percent =
    final.PointsNumerator != null && final.PointsDenominator
      ? (final.PointsNumerator / final.PointsDenominator) * 100
      : null;
  return { percent, display: final.DisplayedGrade ?? null };
}

export function lastModifiedOf(values: D2lGradeValue[]): number | null {
  const times = values
    .map((v) => parseD2lDate(v.LastModified))
    .filter((t): t is number => t != null);
  return times.length ? Math.max(...times) : null;
}
