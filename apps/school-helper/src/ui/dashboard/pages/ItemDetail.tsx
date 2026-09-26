import { useEffect, useState } from 'react';
import { db } from '../../../common/db';
import { applyOverride, clearOverride } from '../../../common/merge';
import { effectiveDue, priorityOf } from '../../../common/priority';
import type { Course, Rubric, WorkItem } from '../../../common/types';
import { Banner, Modal, Pill, formatDue } from '../../components/common';
import { notifyDataChanged } from '../../hooks';
import { draftTeacherEmail } from '../../../ai/helpers';

export function ItemDetail({
  item,
  course,
  rubrics,
  onClose,
  onAnswerNotes,
  onRubricCheck,
  onScribe,
}: {
  item: WorkItem;
  course?: Course;
  rubrics: Rubric[];
  onClose: () => void;
  onAnswerNotes: (item: WorkItem) => void;
  onRubricCheck: (item: WorkItem) => void;
  onScribe: (item: WorkItem) => void;
}) {
  const [draft, setDraft] = useState<WorkItem>(item);
  const [emailBusy, setEmailBusy] = useState(false);
  const [email, setEmail] = useState<{ subject: string; body: string; mailto: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(item), [item]);

  const p = priorityOf(draft);
  const itemRubrics = rubrics.filter(
    (r) => r.itemId === item.id || (item.rubricIds ?? []).includes(r.id),
  );

  const save = async (patch: Partial<WorkItem>, overrideFields: string[]) => {
    let next: WorkItem = { ...draft, ...patch };
    for (const f of overrideFields) {
      next = applyOverride(next, f, (patch as Record<string, unknown>)[f]);
    }
    await db.items.put(next);
    setDraft(next);
    notifyDataChanged();
  };

  const releaseField = async (field: string) => {
    const next = clearOverride(draft, field);
    await db.items.put(next);
    setDraft(next);
    notifyDataChanged();
  };

  const dueValue = (() => {
    const d = effectiveDue(draft);
    if (d == null) return '';
    const dt = new Date(d);
    dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
    return dt.toISOString().slice(0, 16);
  })();

  const makeEmail = async (intent: 'extension' | 'clarify' | 'feedback' | 'missing-work') => {
    if (!course) return;
    setEmailBusy(true);
    setError(null);
    try {
      const result = await draftTeacherEmail({
        item: draft,
        course,
        studentName: 'Sid',
        intent,
        disclosureAccepted: true,
      });
      setEmail(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEmailBusy(false);
    }
  };

  return (
    <Modal title={draft.title} onClose={onClose}>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        {course && (
          <Pill>
            <span className="course-dot" style={{ background: course.colour }} /> {course.code}
          </Pill>
        )}
        <Pill>{draft.kind}</Pill>
        <Pill kind={p.score >= 70 ? 'overdue' : p.score >= 45 ? 'today' : undefined}>
          priority {p.score}
        </Pill>
        <Pill>{draft.status}</Pill>
        {draft.hiddenFromList && <Pill kind="today">hidden from the dropbox list</Pill>}
      </div>

      {draft.description && (
        <div
          className="card"
          style={{ background: 'var(--surface-2)', maxHeight: 200, overflow: 'auto' }}
        >
          <p className="sub" style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
            {draft.description}
          </p>
        </div>
      )}

      {draft.feedback && (
        <div className="card">
          <h3>Teacher feedback</h3>
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{draft.feedback}</p>
          {draft.grade != null && (
            <p className="sub" style={{ marginTop: 8 }}>
              Grade: {draft.grade}
              {draft.gradeMax ? ` / ${draft.gradeMax}` : ''}
            </p>
          )}
        </div>
      )}

      <h3 style={{ marginTop: 18 }}>Manual edits</h3>
      <p className="sub" style={{ marginBottom: 10 }}>
        Anything you change here is pinned and survives every future sync until you release it.
      </p>

      <label className="field">
        <span>Due date {draft.overrides?.dueAt && <Pill kind="accent">pinned</Pill>}</span>
        <div className="row">
          <input
            type="datetime-local"
            value={dueValue}
            onChange={(e) => {
              const v = e.target.value ? new Date(e.target.value).getTime() : null;
              void save({ dueAt: v }, ['dueAt']);
            }}
          />
          {draft.overrides?.dueAt && (
            <button className="btn small" onClick={() => releaseField('dueAt')}>
              Release
            </button>
          )}
        </div>
        <p className="sub" style={{ marginTop: 4 }}>
          {formatDue(effectiveDue(draft))}
        </p>
      </label>

      <label className="field">
        <span>Status {draft.overrides?.status && <Pill kind="accent">pinned</Pill>}</span>
        <div className="row">
          <select
            value={draft.status}
            onChange={(e) =>
              void save({ status: e.target.value as WorkItem['status'] }, ['status'])
            }
          >
            {['not-started', 'in-progress', 'submitted', 'graded', 'returned', 'unknown'].map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
          {draft.overrides?.status && (
            <button className="btn small" onClick={() => releaseField('status')}>
              Release
            </button>
          )}
        </div>
      </label>

      <div className="row" style={{ gap: 10 }}>
        <label className="field" style={{ flex: 1 }}>
          <span>Weight (% of grade)</span>
          <input
            type="number"
            value={draft.weight ?? ''}
            onChange={(e) =>
              void save({ weight: e.target.value === '' ? null : Number(e.target.value) }, [
                'weight',
              ])
            }
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Points</span>
          <input
            type="number"
            value={draft.points ?? ''}
            onChange={(e) =>
              void save({ points: e.target.value === '' ? null : Number(e.target.value) }, [
                'points',
              ])
            }
          />
        </label>
      </div>

      <label className="field">
        <span>My notes</span>
        <textarea
          value={draft.notes ?? ''}
          placeholder="Anything you want to remember about this task."
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          onBlur={() => void save({ notes: draft.notes }, [])}
        />
      </label>

      {draft.sources?.length ? (
        <>
          <h3>Sources this lesson provides</h3>
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            {draft.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>{' '}
                <Pill>{s.kind}</Pill>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {itemRubrics.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>Level-4 rubric</h3>
          {itemRubrics.map((r) => (
            <table className="data" key={r.id}>
              <tbody>
                {r.criteria.map((c) => (
                  <tr key={c.name}>
                    <th style={{ width: '32%' }}>{c.name}</th>
                    <td>{c.level4}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      )}

      {error && <Banner kind="danger">{error}</Banner>}

      {email && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>Draft email — you send it yourself</h3>
          <p className="sub">
            <strong>Subject:</strong> {email.subject}
          </p>
          <pre className="notes-output">{email.body}</pre>
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn primary" href={email.mailto}>
              Open in my mail app
            </a>
            <button
              className="btn"
              onClick={() =>
                void navigator.clipboard.writeText(`${email.subject}\n\n${email.body}`)
              }
            >
              Copy
            </button>
          </div>
        </div>
      )}

      <div className="row wrap" style={{ marginTop: 20, gap: 8 }}>
        <button className="btn primary" onClick={() => onAnswerNotes(draft)}>
          Answer notes
        </button>
        <button className="btn" onClick={() => onScribe(draft)} title="Answer in your own words, by voice or typing">
          Scribe mode
        </button>
        <button className="btn" onClick={() => onRubricCheck(draft)} disabled={!itemRubrics.length}>
          Rubric check
        </button>
        <button className="btn" disabled={emailBusy} onClick={() => void makeEmail('clarify')}>
          Draft email: clarify
        </button>
        <button className="btn" disabled={emailBusy} onClick={() => void makeEmail('extension')}>
          Draft email: extension
        </button>
        {draft.url && (
          <a className="btn" href={draft.url} target="_blank" rel="noreferrer">
            Open in D2L
          </a>
        )}
      </div>
    </Modal>
  );
}
