import type { Rubric, RubricCriterion } from '../../common/types';
import { richTextToPlain, type RichText } from './common';

export interface D2lRubricLevel {
  Id: number | string;
  Name: string;
  Points?: number | null;
  RangeStart?: number | null;
}

export interface D2lRubricCell {
  LevelId: number | string;
  Description?: RichText | null;
  Feedback?: RichText | null;
  Points?: number | null;
}

export interface D2lRubricCriterion {
  Id: number | string;
  Name: string;
  Cells?: D2lRubricCell[];
}

export interface D2lRubricGroup {
  Id?: number | string;
  Name?: string;
  Criteria?: D2lRubricCriterion[];
  Levels?: D2lRubricLevel[];
}

export interface D2lRubric {
  Id: number | string;
  Name: string;
  Description?: RichText | null;
  Type?: number;
  ScoringMethod?: number;
  Criteria?: D2lRubricCriterion[];
  Levels?: D2lRubricLevel[];
  CriteriaGroups?: D2lRubricGroup[];
}

/**
 * Pick the level-4 descriptor for each criterion.
 *
 * Ontario rubrics label levels in several ways ("Level 4", "L4", "4 (80-100%)",
 * "Excellent"). We match on name first, then fall back to the highest-point level.
 */
export function level4LevelId(levels: D2lRubricLevel[]): string | null {
  if (!levels?.length) return null;
  const byName = levels.find((l) => /(^|\W)(level\s*4|l4|4)(\W|$)/i.test(l.Name ?? ''));
  if (byName) return String(byName.Id);
  const byWord = levels.find((l) => /excellent|exemplary|outstanding|thorough/i.test(l.Name ?? ''));
  if (byWord) return String(byWord.Id);
  const scored = levels.filter((l) => l.Points != null);
  if (scored.length) {
    const top = scored.reduce((a, b) => ((b.Points ?? 0) > (a.Points ?? 0) ? b : a));
    return String(top.Id);
  }
  return String(levels[levels.length - 1].Id);
}

export function parseRubric(raw: D2lRubric, courseId: string, itemId?: string): Rubric {
  const groups: D2lRubricGroup[] = raw.CriteriaGroups?.length
    ? raw.CriteriaGroups
    : [{ Criteria: raw.Criteria ?? [], Levels: raw.Levels ?? [] }];

  const criteria: RubricCriterion[] = [];

  for (const group of groups) {
    const levels = group.Levels?.length ? group.Levels : (raw.Levels ?? []);
    const targetLevelId = level4LevelId(levels);
    const levelNameById = new Map(levels.map((l) => [String(l.Id), l]));

    for (const crit of group.Criteria ?? []) {
      const cells = crit.Cells ?? [];
      const target = cells.find((c) => String(c.LevelId) === targetLevelId);
      criteria.push({
        name: crit.Name?.trim() || '(unnamed criterion)',
        level4: richTextToPlain(target?.Description) || '(no level-4 descriptor published)',
        points: target?.Points ?? levelNameById.get(String(targetLevelId))?.Points ?? undefined,
        levels: cells.map((c) => ({
          name: levelNameById.get(String(c.LevelId))?.Name ?? String(c.LevelId),
          descriptor: richTextToPlain(c.Description),
          points: c.Points ?? undefined,
        })),
      });
    }
  }

  return {
    id: `${courseId}:rubric:${raw.Id}`,
    courseId,
    itemId,
    name: raw.Name?.trim() || '(untitled rubric)',
    criteria,
  };
}

export function parseRubrics(raws: D2lRubric[], courseId: string, itemId?: string): Rubric[] {
  return (raws ?? []).map((r) => parseRubric(r, courseId, itemId));
}
