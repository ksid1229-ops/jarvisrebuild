import { useMemo, useState } from 'react';
import { db } from '../../../common/db';
import type { Rubric, SourceRef, WorkItem } from '../../../common/types';
import {
  generateAnswerNotes,
  type AnswerNotesResult,
  type LoadedSource,
} from '../../../ai/answerNotes';
import { runRubricCheck, coverage, type RubricCheckResult } from '../../../ai/rubricCheck';
import { isOpinionQuestion, stanceOptions } from '../../../ai/guardrails';
import { Banner, Empty, Pill } from '../../components/common';
import { notifyDataChanged, useCourses, useItems, useQuestions, useRubrics } from '../../hooks';

const STYLE_GUIDE_KEY = 'school-helper.style-guide';

/**
 * Answer notes.
 * Notes only — the guardrails in ai/guardrails.ts make finished answers
 * impossible by design, not by setting.
 */
export function AnswerNotesPage({ preselect }: { preselect?: WorkItem }) {
  const items = useItems();
  const courses = useCourses();
  const [itemId, setItemId] = useState(preselect?.id ?? '');
  const [questionsText, setQuestionsText] = useState('');
  const [extraSourceUrl, setExtraSourceUrl] = useState('');
  const [extraSourceText, setExtraSourceText] = useState('');
  const [stances, setStances] = useState<Record<number, string>>({});
  const [result, setResult] = useState<AnswerNotesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const item = items.find((i) => i.id === itemId);
  const course = courses.find((c) => c.id === item?.courseId);
  const questions = useMemo(
    () =>
      questionsText
        .split('\n')
        .map((q) => q.trim())
        .filter((q) => q.length > 3),
    [questionsText],
  );
  const opinionQs = questions.map((q, i) => ({ q, i })).filter((x) => isOpinionQuestion(x.q));

  const lessonSources: SourceRef[] = item?.sources ?? [];

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const sources: LoadedSource[] = [];
      for (const ref of lessonSources) {
        // Text extraction for D2L-hosted HTML happens in the worker; links the
        // student pastes are used as-is. Anything unreadable is simply skipped
        // rather than silently replaced by the model's own knowledge.
        sources.push({ ref, text: `${ref.title}\n${ref.url}` });
      }
      if (extraSourceText.trim()) {
        sources.push({
          ref: {
            kind: 'link',
            title: extraSourceUrl || 'Source I pasted',
            url: extraSourceUrl || 'pasted-by-student',
            userProvided: true,
          },
          text: extraSourceText,
        });
      }
      const out = await generateAnswerNotes({
        questions,
        sources,
        courseCode: course?.code ?? 'course',
        stances,
        disclosureAccepted: true,
      });
      setResult(out);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Answer notes</h1>
          <p className="sub">
            Notes and evidence links only — never a finished answer. That rule cannot be turned off.
          </p>
        </div>
      </div>

      <Banner kind="info">
        Every bullet must trace back to a source you supply. Anything the model brings in from
        outside gets flagged as
        <strong> NOT IN SOURCE</strong>. You still write the answer yourself, in your own words.
      </Banner>

      <div className="card">
        <label className="field">
          <span>Lesson or worksheet</span>
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">— pick an item —</option>
            {items
              .filter((i) => i.kind === 'lesson' || i.kind === 'assignment')
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {courses.find((c) => c.id === i.courseId)?.code} · {i.title}
                </option>
              ))}
          </select>
        </label>

        {item && (
          <div style={{ marginBottom: 12 }}>
            <h3>Sources this lesson provides ({lessonSources.length})</h3>
            {lessonSources.length ? (
              <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                {lessonSources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>{' '}
                    <Pill>{s.kind}</Pill>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>
                This lesson has no linked sources. Paste one below, or notes cannot be generated.
              </Empty>
            )}
          </div>
        )}

        <label className="field">
          <span>Questions — one per line</span>
          <textarea
            value={questionsText}
            onChange={(e) => setQuestionsText(e.target.value)}
            placeholder={
              '1. What are the four main entry modes into a foreign market?\n2. Do you think tariffs help domestic producers?'
            }
          />
        </label>

        <details>
          <summary style={{ cursor: 'pointer', marginBottom: 8 }}>Add a source of my own</summary>
          <label className="field">
            <span>Source URL (for the citation link)</span>
            <input
              type="url"
              value={extraSourceUrl}
              onChange={(e) => setExtraSourceUrl(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Paste the source text</span>
            <textarea
              value={extraSourceText}
              onChange={(e) => setExtraSourceText(e.target.value)}
            />
          </label>
        </details>

        {opinionQs.length > 0 && (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <h3>These are opinion questions — pick your side first</h3>
            {opinionQs.map(({ q, i }) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <p className="sub" style={{ color: 'var(--text)' }}>
                  {q}
                </p>
                <div className="row wrap">
                  {stanceOptions(q).map((opt) => (
                    <button
                      key={opt}
                      className={`btn small ${stances[i] === opt ? 'primary' : ''}`}
                      onClick={() => setStances({ ...stances, [i]: opt })}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          className="btn primary"
          disabled={busy || !questions.length || (!lessonSources.length && !extraSourceText.trim())}
          onClick={() => void run()}
        >
          {busy ? 'Working…' : 'Get notes'}
        </button>
      </div>

      {error && <Banner kind="danger">{error}</Banner>}

      {result && (
        <div className="card">
          {result.needsStance.length > 0 && (
            <Banner kind="warn">
              Pick a side for the opinion questions above, then run it again.
            </Banner>
          )}
          {result.violations.map((v, i) => (
            <Banner kind="warn" key={i}>
              {v}
            </Banner>
          ))}
          {result.markdown && <div className="notes-output">{result.markdown}</div>}
          {result.usage.model && (
            <p className="sub" style={{ marginTop: 10 }}>
              {result.usage.model} · {result.usage.promptTokens + result.usage.completionTokens}{' '}
              tokens · ~$
              {result.usage.estimatedCostUsd.toFixed(4)}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** Rubric check — reviews the student's own writing against level 4. */
export function RubricCheckPage({ preselect }: { preselect?: WorkItem }) {
  const items = useItems();
  const courses = useCourses();
  const rubrics = useRubrics();
  const [itemId, setItemId] = useState(preselect?.id ?? '');
  const [rubricId, setRubricId] = useState('');
  const [answer, setAnswer] = useState('');
  const [styleGuide, setStyleGuide] = useState(() => localStorage.getItem(STYLE_GUIDE_KEY) ?? '');
  const [result, setResult] = useState<RubricCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const item = items.find((i) => i.id === itemId);
  const course = courses.find((c) => c.id === item?.courseId);
  const candidates: Rubric[] = useMemo(
    () =>
      item
        ? rubrics.filter((r) => r.itemId === item.id || (item.rubricIds ?? []).includes(r.id))
        : rubrics,
    [item, rubrics],
  );
  const rubric = candidates.find((r) => r.id === rubricId) ?? candidates[0];

  const run = async () => {
    if (!rubric) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      localStorage.setItem(STYLE_GUIDE_KEY, styleGuide);
      const out = await runRubricCheck({
        myAnswer: answer,
        rubric,
        taskTitle: item?.title ?? rubric.name,
        courseCode: course?.code ?? '',
        styleGuide: styleGuide || undefined,
        disclosureAccepted: true,
      });
      setResult(out);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cov = result ? coverage(result.findings) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rubric check</h1>
          <p className="sub">
            Paste your own answer. It gets compared against the level-4 descriptors, in your voice.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1 }}>
            <span>Task</span>
            <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">— pick a task —</option>
              {items
                .filter((i) => i.kind === 'assignment' || i.kind === 'discussion')
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {courses.find((c) => c.id === i.courseId)?.code} · {i.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Rubric ({candidates.length} available)</span>
            <select value={rubric?.id ?? ''} onChange={(e) => setRubricId(e.target.value)}>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {rubric && (
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer' }}>
              Level-4 descriptors ({rubric.criteria.length})
            </summary>
            <table className="data" style={{ marginTop: 8 }}>
              <tbody>
                {rubric.criteria.map((c) => (
                  <tr key={c.name}>
                    <th style={{ width: '30%' }}>{c.name}</th>
                    <td>{c.level4}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        <label className="field">
          <span>My answer (your own writing)</span>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            style={{ minHeight: 220 }}
          />
        </label>

        <details>
          <summary style={{ cursor: 'pointer', marginBottom: 8 }}>
            My style guide — paste 04_style_guide.md so suggestions sound like me
          </summary>
          <textarea value={styleGuide} onChange={(e) => setStyleGuide(e.target.value)} />
        </details>

        <button
          className="btn primary"
          disabled={busy || !answer.trim() || !rubric}
          onClick={() => void run()}
        >
          {busy ? 'Checking…' : 'Check against level 4'}
        </button>
        {!rubric && (
          <p className="sub">No rubric stored yet. Sync the course, or add criteria manually.</p>
        )}
      </div>

      {error && <Banner kind="danger">{error}</Banner>}

      {result && (
        <>
          <div className="card">
            <div className="row spread">
              <h2 style={{ margin: 0 }}>Overall</h2>
              {cov && (
                <Pill kind={cov.pct >= 75 ? 'ok' : cov.pct >= 40 ? 'today' : 'overdue'}>
                  {cov.met}/{cov.total} criteria at level 4
                </Pill>
              )}
            </div>
            <p style={{ marginBottom: 0 }}>{result.overall}</p>
          </div>

          {result.findings.map((f) => (
            <div className="card" key={f.criterion}>
              <div className="row spread" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>{f.criterion}</h3>
                <Pill
                  kind={
                    f.verdict === 'meets-level-4'
                      ? 'ok'
                      : f.verdict === 'close'
                        ? 'today'
                        : 'overdue'
                  }
                >
                  {f.verdict.replace(/-/g, ' ')}
                </Pill>
              </div>

              {f.missing.length > 0 && (
                <>
                  <h4 style={{ margin: '10px 0 4px', fontSize: 13 }}>Missing for level 4</h4>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {f.missing.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </>
              )}

              {f.factualErrors.length > 0 && (
                <>
                  <h4 style={{ margin: '10px 0 4px', fontSize: 13 }}>Factual corrections</h4>
                  {f.factualErrors.map((e, i) => (
                    <p key={i} className="sub" style={{ margin: '4px 0' }}>
                      <s>{e.claim}</s> →{' '}
                      <strong style={{ color: 'var(--text)' }}>{e.correction}</strong>
                    </p>
                  ))}
                </>
              )}

              {f.edits.length > 0 && (
                <>
                  <h4 style={{ margin: '10px 0 4px', fontSize: 13 }}>
                    Suggested edits (your wording, kept)
                  </h4>
                  {f.edits.map((e, i) => (
                    <div
                      key={i}
                      className="card"
                      style={{ background: 'var(--surface-2)', marginBottom: 8 }}
                    >
                      <p className="mono" style={{ margin: 0, color: 'var(--danger)' }}>
                        − {e.before}
                      </p>
                      <p className="mono" style={{ margin: '4px 0 0', color: 'var(--ok)' }}>
                        + {e.after}
                      </p>
                      <p className="sub" style={{ marginTop: 6 }}>
                        {e.why}
                      </p>
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

/** Questions to ask each teacher, grouped by teacher. */
export function QuestionsPage() {
  const courses = useCourses();
  const questions = useQuestions();
  const [text, setText] = useState('');
  const [courseId, setCourseId] = useState('');

  const add = async () => {
    const course = courses.find((c) => c.id === courseId) ?? courses[0];
    if (!course || !text.trim()) return;
    await db.questions.put({
      id: `q-${Date.now()}`,
      courseId: course.id,
      teacher: course.teacher,
      question: text.trim(),
      asked: false,
      answered: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setText('');
    notifyDataChanged();
  };

  const byTeacher = useMemo(() => {
    const map = new Map<string, typeof questions>();
    for (const q of questions) {
      const key = q.teacher || 'Unassigned';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(q);
    }
    return map;
  }, [questions]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Questions for my teachers</h1>
          <p className="sub">Add them as they come up, tick them off once you've asked.</p>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
          <label className="field" style={{ flex: 2, marginBottom: 0 }}>
            <span>New question</span>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Does the ISU need APA citations?"
            />
          </label>
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span>Course</span>
            <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.teacher}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={() => void add()}>
            Add
          </button>
        </div>
      </div>

      {[...byTeacher.entries()].map(([teacher, list]) => (
        <div className="card" key={teacher}>
          <div className="row spread" style={{ marginBottom: 6 }}>
            <h2 style={{ margin: 0 }}>{teacher}</h2>
            <Pill>{list.filter((q) => !q.asked).length} to ask</Pill>
          </div>
          {list.map((q) => (
            <div className={`checkline ${q.asked ? 'done' : ''}`} key={q.id}>
              <input
                type="checkbox"
                checked={q.asked}
                onChange={async () => {
                  await db.questions.update(q.id, { asked: !q.asked, updatedAt: Date.now() });
                  notifyDataChanged();
                }}
              />
              <span className="text" style={{ flex: 1 }}>
                {q.question}
              </span>
              <button
                className="btn small ghost"
                onClick={async () => {
                  await db.questions.delete(q.id);
                  notifyDataChanged();
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ))}

      {!questions.length && <Empty>No questions yet.</Empty>}
    </>
  );
}
