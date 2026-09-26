import { describe, expect, it } from 'vitest';
import gradesFixture from '../src/d2l/fixtures/grades.json';
import quizzesFixture from '../src/d2l/fixtures/quizzes.json';
import discussionsFixture from '../src/d2l/fixtures/discussions.json';
import newsFixture from '../src/d2l/fixtures/news.json';
import rubricsFixture from '../src/d2l/fixtures/rubrics.json';
import enrollmentsFixture from '../src/d2l/fixtures/enrollments.json';
import {
  applyGrades,
  finalGrade,
  indexGrades,
  type D2lGradeObject,
  type D2lGradeValue,
} from '../src/d2l/parsers/grades';
import { parseQuizzes, type D2lQuiz } from '../src/d2l/parsers/quizzes';
import {
  parseDiscussions,
  type D2lDiscussionTopic,
  type D2lForum,
} from '../src/d2l/parsers/discussions';
import { parseAnnouncements, type D2lNewsItem } from '../src/d2l/parsers/news';
import { level4LevelId, parseRubric, type D2lRubric } from '../src/d2l/parsers/rubrics';
import { parseEnrollments } from '../src/d2l/parsers/enrollments';
import { pickVersion, redactUrl } from '../src/d2l/client';
import { assertReadOnly, assertSafePath } from '../src/d2l/endpoints';
import { findCrossBoardLinks } from '../src/d2l/sso';
import { redactBody } from '../src/d2l/capture';
import type { WorkItem } from '../src/common/types';

const CTX = {
  courseId: 'ldsb:29940528',
  board: 'ldsb' as const,
  origin: 'https://ldsb.elearningontario.ca',
  orgUnitId: '29940528',
  now: 1_760_000_000_000,
};

describe('grades parser', () => {
  const objects = gradesFixture.objects as D2lGradeObject[];
  const values = gradesFixture.values as D2lGradeValue[];

  it('indexes grade values by tool item id', () => {
    const index = indexGrades(objects, values);
    expect(index.byToolItem.get('550012')?.PointsNumerator).toBe(17);
    expect(index.weightById.get('60011')).toBe(5);
  });

  it('applies grades and weights onto matching items', () => {
    const items: WorkItem[] = [
      {
        id: 'a',
        courseId: CTX.courseId,
        board: 'ldsb',
        kind: 'assignment',
        remoteId: '550012',
        title: 'WS',
        status: 'submitted',
        firstSeenAt: 0,
        lastSeenAt: 0,
        presentInLastSync: true,
      },
      {
        id: 'b',
        courseId: CTX.courseId,
        board: 'ldsb',
        kind: 'quiz',
        remoteId: '44021',
        title: 'Quiz',
        status: 'unknown',
        firstSeenAt: 0,
        lastSeenAt: 0,
        presentInLastSync: true,
      },
    ];
    const out = applyGrades(items, indexGrades(objects, values), objects);
    expect(out[0].grade).toBe(17);
    expect(out[0].weight).toBe(5);
    expect(out[0].status).toBe('graded');
    expect(out[1].grade).toBe(8);
    expect(out[1].weight).toBe(3);
  });

  it('finds the final calculated grade', () => {
    expect(finalGrade(values).percent).toBe(82);
  });
});

describe('quiz parser', () => {
  it('skips inactive quizzes and keeps due dates', () => {
    const items = parseQuizzes(quizzesFixture.Objects as D2lQuiz[], CTX);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Unit 1 Check-in Quiz');
    expect(items[0].dueAt).toBe(Date.parse('2026-09-20T03:59:00.000Z'));
    expect(items[0].url).toContain('qi=44021');
  });
});

describe('discussion parser', () => {
  it('skips hidden forums and prefixes the forum name', () => {
    const items = parseDiscussions(
      discussionsFixture.forums as D2lForum[],
      discussionsFixture.topics as Record<string, D2lDiscussionTopic[]>,
      CTX,
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe(
      'Unit 1 Discussions — Should Canada pursue more free trade agreements?',
    );
    expect(items[0].points).toBe(10);
    expect(items[0].dueAt).toBe(Date.parse('2026-09-25T03:59:00.000Z'));
  });
});

describe('announcement parser', () => {
  it('skips unpublished announcements and keeps links', () => {
    const items = parseAnnouncements(newsFixture as D2lNewsItem[], CTX);
    expect(items).toHaveLength(1);
    expect(items[0].sources![0].url).toContain('1WorkSheetDocIdAbCdEfGhIjKlMnOp');
  });
});

describe('rubric parser', () => {
  it('finds the level-4 level by name', () => {
    expect(
      level4LevelId([
        { Id: 1, Name: 'Level 1' },
        { Id: 4, Name: 'Level 4 (80-100%)' },
      ]),
    ).toBe('4');
  });

  it('falls back to the highest-point level when names differ', () => {
    expect(
      level4LevelId([
        { Id: 9, Name: 'Developing', Points: 2 },
        { Id: 10, Name: 'Exemplary', Points: 8 },
      ]),
    ).toBe('10');
  });

  it('extracts the level-4 descriptor for each criterion', () => {
    const rubric = parseRubric((rubricsFixture as D2lRubric[])[0], CTX.courseId, 'item-1');
    expect(rubric.criteria).toHaveLength(2);
    expect(rubric.criteria[0].level4).toContain('thorough understanding of all four entry modes');
    expect(rubric.criteria[0].points).toBe(20);
    expect(rubric.criteria[1].level4).toContain('high degree of effectiveness');
  });
});

describe('enrollment parser', () => {
  it('keeps course offerings only and enriches known courses', () => {
    const courses = parseEnrollments(enrollmentsFixture, 'ldsb');
    expect(courses).toHaveLength(2);
    expect(courses[0].teacher).toBe('Ms. Pardy');
    expect(courses[1].code).toBe('ENG4UE-02');
  });
});

describe('read-only guards', () => {
  it('refuses non-GET methods', () => {
    expect(() => assertReadOnly('POST')).toThrow(/read-only/i);
    expect(() => assertReadOnly('get')).not.toThrow();
  });

  it('blocks state-changing URL shapes even for GET', () => {
    expect(() => assertSafePath('https://x/d2l/lms/dropbox/user/submit')).toThrow();
    expect(() => assertSafePath('https://x/d2l/le/news/1/markasread')).toThrow();
    expect(() => assertSafePath('https://x/d2l/api/le/1.69/123/content/root/')).not.toThrow();
  });

  it('redacts tokens and user ids out of logged URLs', () => {
    expect(redactUrl('https://x/api?token=abc123&ou=1')).toContain('token=REDACTED');
    expect(redactUrl('https://x/d2l/api/lp/1.31/users/4455661')).toContain('/users/REDACTED');
  });
});

describe('api version negotiation', () => {
  it('picks the highest supported version at or below the target', () => {
    expect(pickVersion(['1.0', '1.50', '1.69', '1.74'], '1.69')).toBe('1.69');
    expect(pickVersion(['1.0', '1.30', '1.65'], '1.69')).toBe('1.65');
    expect(pickVersion(['1.80'], '1.69')).toBe('1.80');
  });
});

describe('LDSB → Durham SSO', () => {
  it('finds the cross-board widget link and prefers the durham one', () => {
    const html = `
      <div class="d2l-widget">
        <a href="/d2l/le/content/29940528/Home">My course</a>
        <a href="/d2l/lp/auth/remoteplugin/launch?providerId=7">My Courses in Other Boards</a>
        <a href="https://durham.elearningontario.ca/d2l/home/29725166">Durham CIA4U</a>
      </div>`;
    const links = findCrossBoardLinks(html, 'https://ldsb.elearningontario.ca');
    expect(links[0]).toContain('durham');
    expect(links.some((l) => l.includes('remoteplugin'))).toBe(true);
  });
});

describe('fixture redaction', () => {
  it('strips names, emails and student numbers but keeps structural ids', () => {
    const raw = JSON.stringify({
      Id: 550012,
      DisplayName: 'Sid Example',
      EmailAddress: 'sid@student.ldsb.ca',
      OrgDefinedId: '123 456 789',
      Body: { Text: 'Contact ms.pardy@ldsb.ca about 123-456-789.' },
    });
    const { body, count } = redactBody(raw);
    expect(body).not.toContain('Sid Example');
    expect(body).not.toContain('sid@student.ldsb.ca');
    expect(body).not.toContain('ms.pardy@ldsb.ca');
    expect(body).toContain('550012');
    expect(count).toBeGreaterThan(3);
  });
});
