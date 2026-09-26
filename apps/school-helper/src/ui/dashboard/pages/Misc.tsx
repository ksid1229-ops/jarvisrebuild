import { useState } from 'react';
import { db } from '../../../common/db';
import type { ChangeRecord } from '../../../common/types';
import { importSeedFiles } from '../../../importer/markdown';
import { docIdFromUrl } from '../../../gdocs/auth';
import {
  allowDoc,
  applyFormatting,
  copyToMyDrive,
  previewFormatting,
  undoFormatting,
} from '../../../gdocs/docsApi';
import type { FormatPlan } from '../../../gdocs/formatter';
import { Banner, Empty, Pill } from '../../components/common';
import { notifyDataChanged, useChanges, useCourses, useSyncs } from '../../hooks';

/** What changed since the last sync. */
export function ChangesPage() {
  const changes = useChanges();
  const courses = useCourses();
  const syncs = useSyncs();
  const [filter, setFilter] = useState<'unseen' | 'all'>('unseen');

  const shown = filter === 'unseen' ? changes.filter((c) => !c.seen) : changes;
  const codeFor = (id: string) => courses.find((c) => c.id === id)?.code ?? '';

  const markAllSeen = async () => {
    await db.changes.toCollection().modify({ seen: true });
    notifyDataChanged();
    void chrome.action?.setBadgeText({ text: '' });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>What changed</h1>
          <p className="sub">Diffed against the previous sync.</p>
        </div>
        <div className="row">
          <button
            className={`btn small ${filter === 'unseen' ? 'primary' : ''}`}
            onClick={() => setFilter('unseen')}
          >
            New ({changes.filter((c) => !c.seen).length})
          </button>
          <button
            className={`btn small ${filter === 'all' ? 'primary' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button className="btn small" onClick={() => void markAllSeen()}>
            Mark all read
          </button>
        </div>
      </div>

      {!shown.length && <Empty>Nothing new.</Empty>}

      {shown.map((c: ChangeRecord) => (
        <div className="item" key={c.id}>
          <Pill
            kind={
              c.type === 'new-grade' || c.type === 'new-feedback'
                ? 'ok'
                : c.type === 'due-date'
                  ? 'today'
                  : undefined
            }
          >
            {c.type.replace(/-/g, ' ')}
          </Pill>
          <div style={{ flex: 1 }}>
            <div className="title">{c.title}</div>
            <div className="meta">
              <span>{codeFor(c.courseId)}</span>
              <span>{c.detail}</span>
              <span>{new Date(c.at).toLocaleString('en-CA')}</span>
            </div>
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: 26 }}>Sync history</h2>
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>Trigger</th>
            <th>Items</th>
            <th>Changes</th>
            <th>Requests</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {syncs.map((s) => (
            <tr key={s.id}>
              <td>{new Date(s.startedAt).toLocaleString('en-CA')}</td>
              <td>{s.trigger}</td>
              <td>{s.itemsSeen}</td>
              <td>{s.changes}</td>
              <td>{s.requests.length} GET</td>
              <td>
                {s.ok ? (
                  <Pill kind="ok">ok</Pill>
                ) : (
                  <Pill kind="overdue">{s.errors.length} error(s)</Pill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {syncs.some((s) => s.errors.length) && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Most recent errors</h3>
          <ul>
            {(syncs.find((s) => s.errors.length)?.errors ?? []).map((e, i) => (
              <li key={i} className="sub">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** Import the seed markdown files. */
export function ImportPage() {
  const [result, setResult] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const handleFiles = async (files: FileList) => {
    setBusy(true);
    try {
      const seeds = await Promise.all(
        [...files].map(async (f) => ({ name: f.name, text: await f.text() })),
      );
      const bundle = importSeedFiles(seeds);
      await db.courses.bulkPut(bundle.courses);
      if (bundle.items.length) await db.items.bulkPut(bundle.items);
      if (bundle.questions.length) await db.questions.bulkPut(bundle.questions);
      if (bundle.styleGuide) localStorage.setItem('school-helper.style-guide', bundle.styleGuide);
      setWarnings(bundle.warnings);
      setResult(
        `Imported ${bundle.items.length} items, ${bundle.questions.length} teacher questions, ${bundle.courses.length} courses` +
          (bundle.styleGuide ? ', plus your style guide.' : '.'),
      );
      notifyDataChanged();
    } catch (e) {
      setResult(`Import failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import tracker files</h1>
          <p className="sub">
            Drop in 01_tracker.md … 06_bbb4m_handoff.md. Re-importing is safe; it merges by title.
          </p>
        </div>
      </div>

      <div className="card">
        <label className="btn primary" style={{ cursor: 'pointer', display: 'inline-block' }}>
          {busy ? 'Importing…' : 'Choose markdown files'}
          <input
            type="file"
            accept=".md,text/markdown,text/plain"
            multiple
            hidden
            onChange={(e) => e.target.files && void handleFiles(e.target.files)}
          />
        </label>
        <p className="sub" style={{ marginTop: 12 }}>
          The importer reads markdown tables, <code>- [ ]</code> checklists, <code>## Course</code>{' '}
          headings and “Questions for …” sections. A file named like <code>04_style_guide.md</code>{' '}
          is stored for the rubric check.
        </p>
      </div>

      {result && <Banner kind="ok">{result}</Banner>}
      {warnings.map((w, i) => (
        <Banner kind="warn" key={i}>
          {w}
        </Banner>
      ))}
    </>
  );
}

/** Google Docs worksheet formatter: preview, apply, undo. */
export function DocsFormatterPage() {
  const [url, setUrl] = useState('');
  const [plan, setPlan] = useState<FormatPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<string | null>(null);

  const docId =
    docIdFromUrl(url) ?? (url.trim().length > 20 && !url.includes('/') ? url.trim() : null);

  const preview = async () => {
    if (!docId) return setErr('That does not look like a Google Docs URL.');
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await allowDoc(docId);
      setPlan(await previewFormatting(docId));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setErr(null);
    try {
      const { applied, undoId: id } = await applyFormatting(plan);
      setUndoId(id || null);
      setMsg(`Applied ${applied} edit${applied === 1 ? '' : 's'}.`);
      setPlan(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Worksheet formatter</h1>
          <p className="sub">
            Uses the Google Docs API, never the canvas editor. Always previews first, always
            undoable.
          </p>
        </div>
      </div>

      <div className="card">
        <label className="field">
          <span>Google Doc URL</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.google.com/document/u/0/d/…/edit"
          />
        </label>
        <div className="row wrap">
          <button className="btn primary" disabled={busy || !docId} onClick={() => void preview()}>
            {busy ? 'Reading…' : 'Preview changes'}
          </button>
          <button
            className="btn"
            disabled={busy || !docId}
            onClick={async () => {
              if (!docId) return;
              setBusy(true);
              try {
                const copy = await copyToMyDrive(docId, 'Worksheet copy');
                setMsg(`Copied to your Drive: ${copy.url}`);
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Copy to my Drive
          </button>
          {undoId && (
            <button
              className="btn danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await undoFormatting(undoId);
                  setMsg('Reverted.');
                  setUndoId(null);
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Undo last format
            </button>
          )}
        </div>
      </div>

      {err && <Banner kind="danger">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}

      <div className="card">
        <h3>What it fixes</h3>
        <ul className="sub" style={{ paddingLeft: 18 }}>
          <li>Four blank lines between each question/answer block</li>
          <li>The answer sits directly under its question</li>
          <li>Lists and evidence each on their own line</li>
          <li>Leftover horizontal answer lines and ____ blanks removed</li>
          <li>Evidence turned into links rather than bare URLs</li>
        </ul>
      </div>

      {plan && (
        <div className="card">
          <div className="row spread">
            <h2 style={{ margin: 0 }}>Preview — {plan.title}</h2>
            <Pill>
              {plan.fixes.length} change{plan.fixes.length === 1 ? '' : 's'}
            </Pill>
          </div>
          {!plan.fixes.length ? (
            <Empty>Nothing to fix — this document already matches the format.</Empty>
          ) : (
            <>
              <table className="data" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Fix</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.fixes.map((f, i) => (
                    <tr key={i}>
                      <td>{f.label}</td>
                      <td className="mono" style={{ color: 'var(--danger)' }}>
                        {f.before.slice(0, 90) || '—'}
                      </td>
                      <td className="mono" style={{ color: 'var(--ok)' }}>
                        {f.after.slice(0, 90) || '(removed)'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn primary" disabled={busy} onClick={() => void apply()}>
                  Apply these {plan.fixes.length} changes
                </button>
                <button className="btn" onClick={() => setPlan(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** First-run welcome. */
export function WelcomePage({ go }: { go: (route: string) => void }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Welcome</h1>
          <p className="sub">Three things and you're running.</p>
        </div>
      </div>
      <div className="card">
        <h2>1. Import your tracker files</h2>
        <p className="sub">Drop in the six markdown files to seed the tracker.</p>
        <button className="btn primary" onClick={() => go('#/import')}>
          Go to Import
        </button>
      </div>
      <div className="card">
        <h2>2. Log in to D2L, then sync</h2>
        <p className="sub">
          Open ldsb.elearningontario.ca in a tab and log in. If Economics does not appear, click
          through the “My Courses in Other Boards” widget once so the Durham session exists, then
          press Sync.
        </p>
      </div>
      <div className="card">
        <h2>3. Add an AI key (optional)</h2>
        <p className="sub">The tracker works without it. Notes and rubric checks need a model.</p>
        <button className="btn" onClick={() => go('#/settings')}>
          Go to Settings
        </button>
      </div>
      <Banner kind="info">
        Nothing here leaves your PC except what you explicitly send to the AI provider you configure
        — and you are shown exactly what that is, every time.
      </Banner>
    </>
  );
}
