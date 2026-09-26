import type { Course, WorkItem } from '../common/types';
import { bucketOf, effectiveDue, nextUp, priorityOf } from '../common/priority';
import { complete } from './provider';

/**
 * Small helpers. Each one drafts text for the student to send or read —
 * nothing is ever sent, posted, or submitted on their behalf.
 */

export interface EmailDraftRequest {
  item: WorkItem;
  course: Course;
  studentName: string;
  intent: 'extension' | 'clarify' | 'feedback' | 'missing-work' | 'custom';
  extraContext?: string;
  disclosureAccepted?: boolean;
}

export async function draftTeacherEmail(
  req: EmailDraftRequest,
): Promise<{ subject: string; body: string; mailto: string }> {
  const intentLine: Record<EmailDraftRequest['intent'], string> = {
    extension:
      'politely ask for a short extension, giving an honest reason and proposing a specific new date',
    clarify: 'ask a clear, specific question about what the task requires',
    feedback:
      'ask for feedback on submitted work, or for clarification on a grade already received',
    'missing-work': 'ask what outstanding work is still missing and how to catch up',
    custom: 'write the message described in the extra context',
  };

  const due = effectiveDue(req.item);
  const system = `You draft short, polite, professional emails from a Grade 12 Ontario student to their teacher.
Rules: 4 sentences maximum. No flattery, no filler, no emoji. Plain, direct, respectful.
Never apologise more than once. Never promise something the student did not say.
Reply as JSON: {"subject": "...", "body": "..."} and nothing else.`;

  const user = `STUDENT: ${req.studentName}
TEACHER: ${req.course.teacher}
COURSE: ${req.course.code} ${req.course.name}
TASK: ${req.item.title}${due ? ` (due ${new Date(due).toLocaleDateString('en-CA')})` : ''}
STATUS: ${req.item.status}
PURPOSE: ${intentLine[req.intent]}
${req.extraContext ? `EXTRA CONTEXT FROM THE STUDENT: ${req.extraContext}` : ''}`;

  const result = await complete({
    role: 'cheap',
    feature: 'email-draft',
    temperature: 0.3,
    disclosureAccepted: req.disclosureAccepted,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  let subject = `${req.course.code} — ${req.item.title}`;
  let body = result.text.trim();
  try {
    const start = result.text.indexOf('{');
    const end = result.text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(result.text.slice(start, end + 1));
      subject = String(parsed.subject ?? subject);
      body = String(parsed.body ?? body);
    }
  } catch {}

  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { subject, body, mailto };
}

/** End-of-day summary. Built locally first; the model only tightens the wording. */
export function buildDaySummary(items: WorkItem[], courses: Course[], now = Date.now()): string {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const overdue = items.filter((i) => bucketOf(i, now) === 'overdue');
  const today = items.filter((i) => bucketOf(i, now) === 'today');
  const tomorrow = items.filter((i) => bucketOf(i, now) === 'tomorrow');
  const week = items.filter((i) => bucketOf(i, now) === 'this-week');
  const next = nextUp(items, now);

  const line = (i: WorkItem) =>
    `  - ${byId.get(i.courseId)?.code ?? '??'} · ${i.title} (p${priorityOf(i, now).score})`;
  const section = (label: string, list: WorkItem[]) =>
    list.length ? `${label} (${list.length}):\n${list.slice(0, 8).map(line).join('\n')}` : null;

  return [
    `End of day — ${new Date(now).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' })}`,
    section('OVERDUE', overdue),
    section('DUE TODAY', today),
    section('DUE TOMORROW', tomorrow),
    section('LATER THIS WEEK', week),
    next
      ? `\nStart here tomorrow: ${next.item.title} — ${next.why}`
      : '\nNothing outstanding. Take the evening off.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function polishDaySummary(
  plain: string,
  disclosureAccepted?: boolean,
): Promise<string> {
  try {
    const result = await complete({
      role: 'cheap',
      feature: 'day-summary',
      temperature: 0.2,
      maxTokens: 400,
      disclosureAccepted,
      messages: [
        {
          role: 'system',
          content:
            'Rewrite this school to-do summary as 4-6 short lines a student can read at a glance. Keep every task name and due date exactly. No motivational filler.',
        },
        { role: 'user', content: plain },
      ],
    });
    return result.text.trim();
  } catch {
    return plain; // the local summary is always good enough on its own
  }
}
