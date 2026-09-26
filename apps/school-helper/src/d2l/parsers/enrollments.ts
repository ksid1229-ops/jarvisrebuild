import type { BoardId, Course } from '../../common/types';
import { SEED_COURSES } from '../../common/settings';

export interface D2lEnrollment {
  OrgUnit: {
    Id: number | string;
    Type?: { Id: number; Code: string; Name: string };
    Name: string;
    Code?: string | null;
  };
  Access?: {
    IsActive?: boolean;
    StartDate?: string | null;
    EndDate?: string | null;
    CanAccess?: boolean;
    ClasslistRoleName?: string | null;
  };
  Role?: { Id: number; Code?: string | null; Name: string };
}

export interface PagedResult<T> {
  PagingInfo?: { Bookmark?: string | null; HasMoreItems?: boolean };
  Items: T[];
}

const PALETTE = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'];

export function parseEnrollments(
  page: PagedResult<D2lEnrollment> | D2lEnrollment[],
  board: BoardId,
  now = Date.now(),
): Course[] {
  const items = Array.isArray(page) ? page : (page.Items ?? []);
  return items
    .filter(
      (e) =>
        e.OrgUnit?.Type?.Code === 'Course Offering' ||
        e.OrgUnit?.Type?.Id === 3 ||
        !e.OrgUnit?.Type,
    )
    .filter((e) => e.Access?.CanAccess !== false)
    .map((e, i) => {
      const orgUnitId = String(e.OrgUnit.Id);
      const seed = SEED_COURSES.find((s) => s.orgUnitId === orgUnitId);
      return {
        id: `${board}:${orgUnitId}`,
        board,
        orgUnitId,
        code: seed?.code ?? e.OrgUnit.Code ?? orgUnitId,
        name: seed?.name ?? e.OrgUnit.Name,
        teacher: seed?.teacher ?? '',
        colour: seed?.colour ?? PALETTE[i % PALETTE.length],
        active: e.Access?.IsActive !== false,
        lastSyncedAt: now,
      } satisfies Course;
    });
}

/** Courses we always track, even if the enrolment read fails. */
export function knownCourses(now = Date.now()): Course[] {
  return SEED_COURSES.map((s) => ({
    id: `${s.board}:${s.orgUnitId}`,
    board: s.board,
    orgUnitId: s.orgUnitId,
    code: s.code,
    name: s.name,
    teacher: s.teacher,
    colour: s.colour,
    active: true,
    lastSyncedAt: now,
  }));
}
