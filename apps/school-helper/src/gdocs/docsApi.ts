import { db, getSettings, saveSettings } from '../common/db';
import type { UndoRecord } from '../common/types';
import { signIn } from './auth';
import { parseDocument, planFormatting, type DocModel, type FormatPlan } from './formatter';

const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await signIn(true);
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

/** A doc must be explicitly allow-listed by the user before we touch it. */
export async function allowDoc(docId: string): Promise<void> {
  const settings = await getSettings();
  if (settings.google.allowedDocIds.includes(docId)) return;
  await saveSettings({
    google: { ...settings.google, allowedDocIds: [...settings.google.allowedDocIds, docId] },
  });
}

async function assertAllowed(docId: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.google.allowedDocIds.includes(docId)) {
    throw new Error(`Document ${docId} has not been approved. Click "Use this document" first.`);
  }
}

export async function fetchDocument(docId: string): Promise<DocModel> {
  await assertAllowed(docId);
  const res = await authedFetch(`${DOCS_BASE}/${docId}`);
  if (!res.ok) {
    throw new Error(`Could not read the document (${res.status}). ${await shortBody(res)}`);
  }
  return parseDocument(await res.json());
}

/** Step 1 of the fixer: read the doc and plan the edits. Nothing is written. */
export async function previewFormatting(docId: string): Promise<FormatPlan> {
  const doc = await fetchDocument(docId);
  return planFormatting(doc);
}

/** Step 2: apply the plan and store an undo record. */
export async function applyFormatting(
  plan: FormatPlan,
): Promise<{ applied: number; undoId: string }> {
  await assertAllowed(plan.documentId);
  if (!plan.requests.length) return { applied: 0, undoId: '' };

  const undo: UndoRecord = {
    id: `undo-${Date.now()}`,
    at: Date.now(),
    kind: 'gdocs-format',
    docId: plan.documentId,
    title: plan.title,
    payload: { snapshot: plan.snapshot, revisionId: plan.revisionId, fixes: plan.fixes },
    applied: false,
  };
  await db.undos.put(undo);

  const res = await authedFetch(`${DOCS_BASE}/${plan.documentId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: plan.requests,
      writeControl: plan.revisionId ? { requiredRevisionId: plan.revisionId } : undefined,
    }),
  });

  if (!res.ok) {
    const body = await shortBody(res);
    await db.undos.delete(undo.id);
    if (res.status === 400 && /revision/i.test(body)) {
      throw new Error(
        'The document changed since the preview. Re-run the preview and apply again.',
      );
    }
    throw new Error(`Formatting failed (${res.status}). ${body}`);
  }

  await db.undos.update(undo.id, { applied: true });
  return { applied: plan.requests.length, undoId: undo.id };
}

/**
 * Undo: restores the paragraph text captured before the run.
 * Formatting-only changes (links) are not restored by text replacement, so the
 * undo record keeps the fix list for manual reference too.
 */
export async function undoFormatting(undoId: string): Promise<void> {
  const record = await db.undos.get(undoId);
  if (!record) throw new Error('That undo record no longer exists.');
  if (record.revertedAt) throw new Error('This change has already been undone.');

  const payload = record.payload as { snapshot: string };
  const current = await fetchDocument(record.docId);
  const endIndex = current.paragraphs.length
    ? current.paragraphs[current.paragraphs.length - 1].end
    : 1;

  const requests: unknown[] = [];
  if (endIndex > 2) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  requests.push({ insertText: { location: { index: 1 }, text: payload.snapshot } });

  const res = await authedFetch(`${DOCS_BASE}/${record.docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Undo failed (${res.status}). ${await shortBody(res)}`);

  await db.undos.update(undoId, { revertedAt: Date.now() });
}

/** "Copy worksheet to my Drive" — copies into the personal account's Drive. */
export async function copyToMyDrive(
  docId: string,
  newTitle?: string,
): Promise<{ id: string; url: string }> {
  await allowDoc(docId);
  const res = await authedFetch(`${DRIVE_BASE}/${docId}/copy`, {
    method: 'POST',
    body: JSON.stringify({ name: newTitle ?? undefined }),
  });
  if (!res.ok) throw new Error(`Copy failed (${res.status}). ${await shortBody(res)}`);
  const json = (await res.json()) as { id: string; name: string };
  await allowDoc(json.id);
  return { id: json.id, url: `https://docs.google.com/document/d/${json.id}/edit` };
}

/** Plain text of a doc, used as an answer-notes source. */
export async function docPlainText(docId: string): Promise<string> {
  const doc = await fetchDocument(docId);
  return doc.paragraphs.map((p) => p.text).join('\n');
}

async function shortBody(res: Response): Promise<string> {
  try {
    const t = await res.text();
    const j = JSON.parse(t) as { error?: { message?: string } };
    return (j.error?.message ?? t).slice(0, 300);
  } catch {
    return '';
  }
}
