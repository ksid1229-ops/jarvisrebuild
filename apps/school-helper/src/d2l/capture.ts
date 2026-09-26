import { db } from '../common/db';
import type { BoardId, FixtureCapture } from '../common/types';

/**
 * "Capture debug fixtures" — saves real D2L responses, redacted, so they can be
 * handed back later to harden the parsers against the live shapes.
 *
 * Redaction is deliberately aggressive: it is better to lose a field than to
 * leak a name, an email, or a student id into a file that gets shared.
 */

export interface RedactionResult {
  body: string;
  count: number;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const OEN_RE = /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/g; // Ontario Education Number
const LONG_ID_RE = /\b\d{7,}\b/g;

/** Keys whose values are replaced wholesale. */
const SENSITIVE_KEYS = new Set([
  'DisplayName',
  'FirstName',
  'LastName',
  'MiddleName',
  'UserName',
  'EmailAddress',
  'ExternalEmail',
  'OrgDefinedId',
  'Identifier',
  'UniqueName',
  'ProfileIdentifier',
  'Pronouns',
]);

/** Keys that are structural ids we want to keep so parsers still make sense. */
const KEEP_IDS = new Set([
  'Id',
  'TopicId',
  'ForumId',
  'QuizId',
  'ModuleId',
  'GradeObjectIdentifier',
  'FileId',
  'LevelId',
  'CategoryId',
  'GradeItemId',
  'ToolItemId',
]);

export function redactBody(raw: string): RedactionResult {
  let count = 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Non-JSON (HTML). Scrub text patterns and drop the body to a short excerpt.
    const scrubbed = raw
      .replace(EMAIL_RE, () => (count++, 'redacted@example.com'))
      .replace(OEN_RE, () => (count++, '000000000'));
    return { body: scrubbed.slice(0, 20_000), count };
  }

  const walk = (node: unknown, key?: string): unknown => {
    if (node == null) return node;
    if (Array.isArray(node)) return node.map((n) => walk(n));
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v, k);
      return out;
    }
    if (typeof node === 'string') {
      if (key && SENSITIVE_KEYS.has(key)) {
        count++;
        return key.toLowerCase().includes('email') ? 'redacted@example.com' : 'REDACTED';
      }
      let s = node.replace(EMAIL_RE, () => (count++, 'redacted@example.com'));
      s = s.replace(OEN_RE, () => (count++, '000000000'));
      return s;
    }
    if (typeof node === 'number') {
      if (key && SENSITIVE_KEYS.has(key) && !KEEP_IDS.has(key)) {
        count++;
        return 0;
      }
      return node;
    }
    return node;
  };

  const cleaned = walk(parsed);
  let body = JSON.stringify(cleaned, null, 2);

  // Final safety net for anything id-shaped that slipped through free text.
  body = body.replace(EMAIL_RE, () => (count++, 'redacted@example.com'));

  return { body, count };
}

/** Optional stricter mode: also blanks long numeric ids not on the keep list. */
export function redactAggressive(raw: string): RedactionResult {
  const first = redactBody(raw);
  let count = first.count;
  const body = first.body.replace(LONG_ID_RE, (m) => {
    count++;
    return '9'.repeat(m.length);
  });
  return { body, count };
}

export async function saveFixture(params: {
  board: BoardId;
  endpoint: string;
  url: string;
  status: number;
  body: string;
  aggressive?: boolean;
}): Promise<FixtureCapture> {
  const { body, count } = params.aggressive
    ? redactAggressive(params.body)
    : redactBody(params.body);
  const record: FixtureCapture = {
    id: `${params.endpoint}-${params.board}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    board: params.board,
    endpoint: params.endpoint,
    url: params.url.replace(/([?&])(token|x-[a-z])=[^&]*/gi, '$1$2=REDACTED'),
    status: params.status,
    body: body.slice(0, 500_000),
    redactions: count,
  };
  await db.fixtures.put(record);
  return record;
}

/** Bundle every captured fixture into one JSON file the user can hand back. */
export async function exportFixtures(): Promise<string> {
  const all = await db.fixtures.orderBy('at').toArray();
  return JSON.stringify(
    {
      format: 'school-helper-fixtures',
      version: 1,
      exportedAt: Date.now(),
      note: 'Redacted D2L responses captured from a live session. Check before sharing.',
      count: all.length,
      fixtures: all.map((f) => ({
        endpoint: f.endpoint,
        board: f.board,
        url: f.url,
        status: f.status,
        redactions: f.redactions,
        body: safeParse(f.body),
      })),
    },
    null,
    2,
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function clearFixtures(): Promise<void> {
  await db.fixtures.clear();
}
