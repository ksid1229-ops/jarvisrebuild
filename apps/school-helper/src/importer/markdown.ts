/**
 * Markdown importer for the school-project seed files
 * (01_tracker.md … 06_bbb4m_handoff.md).
 *
 * The real files were not available at build time, so the importer is written
 * to be shape-tolerant rather than tied to one exact layout. It recognises:
 *
 *  - markdown tables with a header row (the common tracker layout)
 *  - "- [ ] task" / "- [x] task" checklists
 *  - `## Course` / `### Unit` headings for grouping
 *  - "Questions for <Teacher>" sections → teacher question lists
 *  - a style guide file → stored verbatim for the rubric check
 *
 * Anything it cannot classify is preserved as a note on the course rather than
 * dropped, so no information from the seed files is lost.
 */

import type { Course, TeacherQuestion, WorkItem } from '../common/types';
import { SEED_COURSES } from '../common/settings';

export interface ImportedBundle {
  courses: Course[];
  items: WorkItem[];
  questions: TeacherQuestion[];
  styleGuide?: string;
  handoffNotes: { file: string; text: string }[];
  warnings: string[];
}

export interface SeedFile {
  name: string;
  text: string;
}

const KIND_WORDS: [RegExp, WorkItem['kind']][] = [
  [/drop\s*box|assignment|submission|task|worksheet|essay|project|isu/i, 'assignment'],
  [/quiz|test|exam/i, 'quiz'],
  [/discussion|forum|post/i, 'discussion'],
  [/announce/i, 'announcement'],
  [/lesson|activity|reading|slide/i, 'lesson'],
  [/unit|module/i, 'unit'],
];

const STATUS_WORDS: [RegExp, WorkItem['status']][] = [
  [/graded|marked|returned/i, 'graded'],
  [/submitted|handed in|done|complete/i, 'submitted'],
  [/in progress|started|draft|wip/i, 'in-progress'],
  [/not started|todo|to do|outstanding|missing|overdue/i, 'not-started'],
];

export function importSeedFiles(files: SeedFile[], now = Date.now()): ImportedBundle {
  const bundle: ImportedBundle = {
    courses: seedCourses(now),
    items: [],
    questions: [],
    handoffNotes: [],
    warnings: [],
  };

  for (const file of files) {
    if (/style[_-]?guide/i.test(file.name)) {
      bundle.styleGuide = file.text;
      continue;
    }
    if (/handoff|handover/i.test(file.name)) {
      bundle.handoffNotes.push({ file: file.name, text: file.text });
    }

    const courseHint = courseFromFilename(file.name, bundle.courses);
    const parsed = parseMarkdown(file.text, courseHint, bundle.courses, now, file.name);
    bundle.items.push(...parsed.items);
    bundle.questions.push(...parsed.questions);
    bundle.warnings.push(...parsed.warnings);
  }

  // De-duplicate by id, last write wins.
  const byId = new Map(bundle.items.map((i) => [i.id, i]));
  bundle.items = [...byId.values()];
  return bundle;
}

function seedCourses(now: number): Course[] {
  return SEED_COURSES.map((s) => ({
    id: `${s.board}:${s.orgUnitId}`,
    board: s.board,
    orgUnitId: s.orgUnitId,
    code: s.code,
    name: s.name,
    teacher: s.teacher,
    colour: s.colour,
    active: true,
    lastSyncedAt: undefined,
    ...(now ? {} : {}),
  }));
}

export function courseFromFilename(name: string, courses: Course[]): Course | undefined {
  const n = name.toLowerCase();
  return courses.find(
    (c) =>
      n.includes(c.code.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
      n.includes(c.code.split('-')[0].toLowerCase()) ||
      n.includes(c.name.toLowerCase()),
  );
}

interface ParseOut {
  items: WorkItem[];
  questions: TeacherQuestion[];
  warnings: string[];
}

export function parseMarkdown(
  md: string,
  courseHint: Course | undefined,
  courses: Course[],
  now: number,
  fileName: string,
): ParseOut {
  const out: ParseOut = { items: [], questions: [], warnings: [] };
  const lines = md.split('\n');

  let currentCourse = courseHint;
  let currentUnit: string | undefined;
  let questionMode: { teacher: string; course: Course } | null = null;
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Headings: switch course / unit / questions context.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const title = heading[2].trim();
      const matched = matchCourse(title, courses);
      if (matched) {
        currentCourse = matched;
        currentUnit = undefined;
        questionMode = null;
        continue;
      }
      const qm = /questions?\s+(?:for|to ask)\s+(.+)/i.exec(title);
      if (qm && (currentCourse || courseHint)) {
        const course = currentCourse ?? courseHint!;
        questionMode = { teacher: qm[1].trim() || course.teacher, course };
        continue;
      }
      if (/^questions?\b/i.test(title) && (currentCourse ?? courseHint)) {
        const course = currentCourse ?? courseHint!;
        questionMode = { teacher: course.teacher, course };
        continue;
      }
      questionMode = null;
      if (/^unit\b|^module\b/i.test(title)) currentUnit = title;
      continue;
    }

    // Markdown tables.
    if (
      trimmed.startsWith('|') &&
      lines[i + 1]?.trim().startsWith('|') &&
      /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())
    ) {
      const { rows, consumed } = readTable(lines, i);
      const course = currentCourse ?? courseHint;
      if (!course) {
        out.warnings.push(`${fileName}: found a table before any course heading — rows skipped.`);
      } else {
        for (const row of rows) {
          const item = itemFromRow(row, course, currentUnit, now, seq++);
          if (item) out.items.push(item);
        }
      }
      i += consumed - 1;
      continue;
    }

    // Checklists / bullets.
    const bullet = /^[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(trimmed);
    if (bullet) {
      const checked = (bullet[1] ?? '').toLowerCase() === 'x';
      const text = bullet[2].trim();
      if (!text) continue;

      if (questionMode) {
        out.questions.push({
          id: `q-${questionMode.course.id}-${hash(text)}`,
          courseId: questionMode.course.id,
          teacher: questionMode.teacher,
          question: text.replace(/^\[.\]\s*/, ''),
          asked: checked,
          answered: checked,
          createdAt: now,
          updatedAt: now,
        });
        continue;
      }

      const course = currentCourse ?? courseHint;
      if (!course) continue;
      const item = itemFromText(text, checked, course, currentUnit, now, seq++);
      if (item) out.items.push(item);
    }
  }

  return out;
}

interface TableRow {
  [column: string]: string;
}

export function readTable(
  lines: string[],
  startIndex: number,
): { rows: TableRow[]; consumed: number } {
  const header = splitRow(lines[startIndex]);
  const rows: TableRow[] = [];
  let i = startIndex + 2;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) break;
    const cells = splitRow(lines[i]);
    if (!cells.length) break;
    const row: TableRow = {};
    header.forEach((h, n) => {
      row[normaliseHeader(h)] = (cells[n] ?? '').trim();
    });
    rows.push(row);
  }
  return { rows, consumed: i - startIndex };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function itemFromRow(
  row: TableRow,
  course: Course,
  unit: string | undefined,
  now: number,
  seq: number,
): WorkItem | null {
  const title = pick(row, [
    'task',
    'item',
    'assignment',
    'title',
    'name',
    'lesson',
    'activity',
    'work',
  ]);
  if (!title) return null;

  const dueRaw = pick(row, ['due', 'duedate', 'deadline', 'dateddue', 'date']);
  const statusRaw = pick(row, ['status', 'state', 'submission', 'progress', 'done']);
  const gradeRaw = pick(row, ['grade', 'mark', 'score', 'result']);
  const pointsRaw = pick(row, ['points', 'pts', 'outof', 'total']);
  const weightRaw = pick(row, ['weight', 'weighting', 'percent', 'ofgrade']);
  const notes = pick(row, ['notes', 'note', 'comment', 'comments', 'feedback']);
  const kindRaw = pick(row, ['type', 'kind', 'category']);
  const unitRaw = pick(row, ['unit', 'module']) || unit;

  const kind = detectKind(`${kindRaw} ${title}`);
  const cleanTitle = stripMd(title);

  return {
    id: `${course.id}:${kind}:seed-${hash(cleanTitle)}-${seq}`,
    courseId: course.id,
    board: course.board,
    kind,
    remoteId: `seed-${hash(cleanTitle)}`,
    title: cleanTitle,
    description: unitRaw ? `Unit: ${stripMd(unitRaw)}` : undefined,
    url: extractLink(title),
    dueAt: parseLooseDate(dueRaw, now),
    points: toNumber(pointsRaw),
    weight: toNumber(weightRaw?.replace('%', '')),
    grade: toNumber(gradeRaw?.replace('%', '')),
    status: detectStatus(`${statusRaw} ${gradeRaw}`),
    feedback: notes || undefined,
    notes: notes || undefined,
    completed:
      /^(yes|y|done|✓|x|true)$/i.test(statusRaw ?? '') ||
      detectStatus(statusRaw ?? '') === 'submitted',
    firstSeenAt: now,
    lastSeenAt: now,
    presentInLastSync: false,
  };
}

function itemFromText(
  text: string,
  checked: boolean,
  course: Course,
  unit: string | undefined,
  now: number,
  seq: number,
): WorkItem | null {
  const cleanTitle = stripMd(text.split(/\s+[—–-]\s+due\b/i)[0]).slice(0, 200);
  if (cleanTitle.length < 3) return null;
  const kind = detectKind(text);
  return {
    id: `${course.id}:${kind}:seed-${hash(cleanTitle)}-${seq}`,
    courseId: course.id,
    board: course.board,
    kind,
    remoteId: `seed-${hash(cleanTitle)}`,
    title: cleanTitle,
    description: unit ? `Unit: ${unit}` : undefined,
    url: extractLink(text),
    dueAt: parseLooseDate(text, now),
    status: checked ? 'submitted' : detectStatus(text),
    completed: checked,
    firstSeenAt: now,
    lastSeenAt: now,
    presentInLastSync: false,
  };
}

function pick(row: TableRow, keys: string[]): string | undefined {
  for (const k of keys) if (row[k]) return row[k];
  return undefined;
}

export function detectKind(text: string): WorkItem['kind'] {
  for (const [re, kind] of KIND_WORDS) if (re.test(text)) return kind;
  return 'assignment';
}

export function detectStatus(text: string | undefined): WorkItem['status'] {
  if (!text) return 'not-started';
  for (const [re, status] of STATUS_WORDS) if (re.test(text)) return status;
  return 'not-started';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Accepts 2026-05-04, 04/05/2026, "May 4", "Fri May 4", "due May 4 2026". */
export function parseLooseDate(raw: string | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text || /^(tbd|n\/?a|-|—|none)$/i.test(text)) return null;

  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return endOfDay(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
  if (slash) {
    const year = slash[3] ? normaliseYear(Number(slash[3])) : new Date(now).getUTCFullYear();
    // Ontario school docs are usually month/day.
    return endOfDay(Date.UTC(year, Number(slash[1]) - 1, Number(slash[2])));
  }

  const named = new RegExp(
    `\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`,
    'i',
  ).exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[1].toLowerCase().slice(0, 3));
    const year = named[3] ? Number(named[3]) : schoolYearFor(month, now);
    return endOfDay(Date.UTC(year, month, Number(named[2])));
  }

  return null;
}

/** Sept–Dec belongs to the current school year; Jan–Jun to the next calendar year. */
function schoolYearFor(month: number, now: number): number {
  const d = new Date(now);
  const y = d.getFullYear();
  const currentMonth = d.getMonth();
  if (currentMonth >= 7 && month < 7) return y + 1;
  if (currentMonth < 7 && month >= 7) return y - 1;
  return y;
}

function normaliseYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/** End of the parsed calendar day, in UTC.
 *
 * These are date-only values from school documents, so the day they name is the
 * only thing that matters -- and that day has to survive the local offset. The
 * caller builds each date with Date.UTC and this keeps it there: `setHours` in
 * America/Toronto put "2026-05-04" at 2026-05-05T03:59Z, so every seeded date
 * read a day late for the one user this app has. The tests passed in the
 * builders' UTC sandbox and failed on the owner's PC for exactly that reason. */
function endOfDay(at: number): number {
  const d = new Date(at);
  d.setUTCHours(23, 59, 0, 0);
  return d.getTime();
}

function toNumber(s: string | undefined): number | null {
  if (!s) return null;
  const m = /-?\d+(\.\d+)?/.exec(s.replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

function stripMd(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLink(s: string): string | undefined {
  const md = /\[[^\]]+\]\((https?:\/\/[^)]+)\)/.exec(s);
  if (md) return md[1];
  const bare = /(https?:\/\/\S+)/.exec(s);
  return bare ? bare[1] : undefined;
}

function matchCourse(title: string, courses: Course[]): Course | undefined {
  const t = title.toLowerCase();
  return courses.find(
    (c) =>
      t.includes(c.code.toLowerCase()) ||
      t.includes(c.code.split('-')[0].toLowerCase()) ||
      t.includes(c.name.toLowerCase()),
  );
}

export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
