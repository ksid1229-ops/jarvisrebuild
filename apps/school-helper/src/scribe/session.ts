/**
 * Scribe sessions: pulling the questions out of an assignment, and storing
 * answers so nothing spoken is ever lost.
 */

import { db } from '../common/db';
import type { ScribeAnswer, ScribeSession, WorkItem } from '../common/types';

/** Strips HTML from a D2L description without executing anything. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NUMBERED = /^\s*(?:\(?\d{1,2}[.)]|[a-h][.)]|[•*\-–]|Q\s*\d{1,2}[.:)]?)\s+(.*)$/i;

/**
 * Finds the questions in an assignment description.
 *
 * Tries, in order: numbered/bulleted list items, then lines ending in a
 * question mark, then paragraphs that read like instructions. Returns an empty
 * array when it cannot tell — the UI then asks Sid to paste them, rather than
 * inventing prompts.
 */
export function extractPrompts(description: string | undefined): string[] {
  if (!description?.trim()) return [];
  const text = plainText(description);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const listed = lines
    .map((line) => line.match(NUMBERED)?.[1]?.trim())
    .filter((line): line is string => !!line && line.length > 8);
  if (listed.length >= 2) return dedupe(listed);

  const questions = lines.filter((line) => line.endsWith('?') && line.length > 12);
  if (questions.length >= 1) return dedupe(questions);

  const imperative = lines.filter(
    (line) =>
      line.length > 25 &&
      /^(explain|describe|discuss|analyse|analyze|compare|evaluate|identify|outline|justify|argue|summarise|summarize|define|assess|examine|state|list|why|how|what|which|to what extent)\b/i.test(
        line,
      ),
  );
  if (imperative.length >= 1) return dedupe(imperative);

  return [];
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.slice(0, 40);
}

/** Splits text Sid pasted himself into prompts, one per line or numbered item. */
export function promptsFromPaste(pasted: string): string[] {
  const lines = pasted
    .split('\n')
    .map((line) => line.replace(NUMBERED, '$1').trim())
    .filter((line) => line.length > 0);
  return dedupe(lines);
}

export function sessionId(itemId: string): string {
  return `scribe:${itemId}`;
}

export async function loadSession(itemId: string): Promise<ScribeSession | undefined> {
  return db.scribeSessions.get(sessionId(itemId));
}

export async function startSession(item: WorkItem, pasted?: string): Promise<ScribeSession> {
  const existing = await loadSession(item.id);
  if (existing && existing.prompts.length && !pasted) return existing;

  const fromDescription = extractPrompts(item.description);
  const prompts = pasted ? promptsFromPaste(pasted) : fromDescription;
  const session: ScribeSession = {
    id: sessionId(item.id),
    itemId: item.id,
    courseId: item.courseId,
    title: item.title,
    promptSource: pasted ? 'pasted' : 'description',
    prompts: prompts.map((text, index) => ({ id: `q${index + 1}`, text })),
    answers: existing?.answers ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await db.scribeSessions.put(session);
  return session;
}

/**
 * Saves one answer. The stored `raw` for a question is written once and then
 * left alone: later edits land in `accepted`, so the original capture is always
 * recoverable.
 */
export async function saveAnswer(itemId: string, answer: ScribeAnswer): Promise<ScribeSession> {
  const session = await loadSession(itemId);
  if (!session) throw new Error('no-scribe-session');
  const answers = [...session.answers];
  const index = answers.findIndex((a) => a.questionId === answer.questionId);
  if (index === -1) answers.push(answer);
  else
    answers[index] = {
      ...answer,
      raw: answers[index].raw || answer.raw,
      capturedAt: answers[index].capturedAt,
    };
  const next = { ...session, answers, updatedAt: Date.now() };
  await db.scribeSessions.put(next);
  return next;
}

export async function deleteSession(itemId: string): Promise<void> {
  await db.scribeSessions.delete(sessionId(itemId));
}

/** The accepted answers in question order, ready to copy or send to a Doc. */
export function exportAnswers(session: ScribeSession): { prompt: string; text: string }[] {
  return session.prompts
    .map((prompt) => {
      const answer = session.answers.find((a) => a.questionId === prompt.id);
      if (!answer) return null;
      return { prompt: prompt.text, text: answer.accepted ?? answer.cleaned ?? answer.raw };
    })
    .filter((entry): entry is { prompt: string; text: string } => !!entry && !!entry.text.trim());
}

export function exportAsText(session: ScribeSession): string {
  return exportAnswers(session)
    .map((entry, index) => `${index + 1}. ${entry.prompt}\n\n${entry.text}`)
    .join('\n\n');
}
