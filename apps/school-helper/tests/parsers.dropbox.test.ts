import { describe, expect, it } from 'vitest';
import folders from '../src/d2l/fixtures/dropbox-folders.json';
import hidden from '../src/d2l/fixtures/dropbox-hidden-folder.json';
import submissions from '../src/d2l/fixtures/dropbox-submissions.json';
import {
  applySubmission,
  findHiddenFolderIds,
  parseDropboxFolder,
  submissionStatusOf,
  type D2lDropboxFolder,
  type D2lSubmissionEntity,
} from '../src/d2l/parsers/dropbox';

const CTX = {
  courseId: 'ldsb:29940528',
  board: 'ldsb' as const,
  origin: 'https://ldsb.elearningontario.ca',
  orgUnitId: '29940528',
  now: 1_760_000_000_000,
};

describe('dropbox parser', () => {
  it('parses a folder into a work item with dates, points and rubric ids', () => {
    const item = parseDropboxFolder((folders as D2lDropboxFolder[])[0], CTX);
    expect(item.kind).toBe('assignment');
    expect(item.title).toBe('Unit 1 Worksheet — Entry Modes');
    expect(item.dueAt).toBe(Date.parse('2026-09-19T03:59:00.000Z'));
    expect(item.endAt).toBe(Date.parse('2026-09-26T03:59:00.000Z'));
    expect(item.points).toBe(20);
    expect(item.rubricIds).toEqual(['7301']);
    expect(item.url).toContain('db=550012');
    expect(item.url).toContain('ou=29940528');
  });

  it('extracts sources out of the custom instructions', () => {
    const item = parseDropboxFolder((folders as D2lDropboxFolder[])[0], CTX);
    expect(item.sources![0].kind).toBe('slides');
  });

  it('identifies dropboxes linked from content but absent from the list', () => {
    const links = [
      { kind: 'assignment', remoteId: '550012' },
      { kind: 'assignment', remoteId: '550099' },
      { kind: 'quiz', remoteId: '44021' },
    ];
    expect(findHiddenFolderIds(folders as D2lDropboxFolder[], links)).toEqual(['550099']);
  });

  it('parses a hidden folder fetched by id', () => {
    const item = parseDropboxFolder(hidden as D2lDropboxFolder, CTX);
    expect(item.hiddenFromList).toBe(true);
    expect(item.points).toBe(10);
  });

  it('maps submission status codes', () => {
    expect(submissionStatusOf({ Status: 0, Submissions: [] })).toBe('not-started');
    expect(submissionStatusOf({ Status: 1, Submissions: [] })).toBe('submitted');
    expect(submissionStatusOf({ Status: 2, Submissions: [] })).toBe('in-progress');
    expect(submissionStatusOf({ Status: 3, Submissions: [] })).toBe('returned');
    expect(submissionStatusOf({ Feedback: { IsGraded: true } })).toBe('graded');
    expect(
      submissionStatusOf({
        Status: 0,
        Submissions: [{ Id: 1, SubmissionDate: '2026-09-18T23:41:00.000Z' }],
      }),
    ).toBe('submitted');
  });

  it('folds only MY submission row into the item', () => {
    const base = parseDropboxFolder((folders as D2lDropboxFolder[])[0], CTX);
    const merged = applySubmission(base, submissions as D2lSubmissionEntity[], '4455661');
    expect(merged.status).toBe('graded');
    expect(merged.grade).toBe(17);
    expect(merged.gradeMax).toBe(20);
    expect(merged.submittedAt).toBe(Date.parse('2026-09-18T23:41:00.000Z'));
    expect(merged.feedback).toContain('Expand question 4');
  });

  it('leaves the item alone when my row is not present', () => {
    const base = parseDropboxFolder((folders as D2lDropboxFolder[])[0], CTX);
    const merged = applySubmission(base, submissions as D2lSubmissionEntity[], '9999999');
    expect(merged.grade).toBeUndefined();
    expect(merged.status).toBe('not-started');
  });
});
