import { useEffect, useMemo, useState } from 'react';
import { db } from '../../common/db';
import { isDone, nextUp, priorityOf } from '../../common/priority';
import { docIdFromUrl } from '../../gdocs/auth';
import { allowDoc, previewFormatting, applyFormatting } from '../../gdocs/docsApi';
import type { FormatPlan } from '../../gdocs/formatter';
import { Banner, Empty, Pill, formatDue } from '../components/common';
import { useCourses, useItems, useSettings, useTheme } from '../hooks';
import { effectiveDue } from '../../common/priority';
import '../../ai';

/**
 * Side panel — in-page actions for whatever tab is open.
 * On D2L it shows that course's work; on Google Docs it offers the formatter.
 */
export function SidePanel() {
  const [settings] = useSettings();
  const items = useItems();
  const courses = useCourses();
  const [tabUrl, setTabUrl] = useState('');
  const [plan, setPlan] = useState<FormatPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useTheme(settings?.theme);

  useEffect(() => {
    const read = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTabUrl(tab?.url ?? '');
    };
    void read();
    const id = setInterval(read, 2000);
    return () => clearInterval(id);
  }, []);

  const docId = docIdFromUrl(tabUrl);
  const orgUnitId = useMemo(() => {
    const m = /[?&]ou=(\d+)/.exec(tabUrl) ?? /\/d2l\/le\/content\/(\d+)/.exec(tabUrl);
    return m ? m[1] : null;
  }, [tabUrl]);

  const course = courses.find((c) => c.orgUnitId === orgUnitId);
  const courseItems = useMemo(
    () =>
      items
        .filter((i) => (course ? i.courseId === course.id : true))
        .filter((i) => !isDone(i))
        .sort((a, b) => priorityOf(b).score - priorityOf(a).score)
        .slice(0, 8),
    [items, course],
  );
  const next = useMemo(() => nextUp(items), [items]);

  const openDashboard = (route: string) =>
    chrome.runtime.sendMessage({ type: 'open:dashboard', route });

  return (
    <div className="sp">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>School Helper</h1>
        <button
          className="btn small"
          onClick={() => chrome.runtime.sendMessage({ type: 'sync:start', trigger: 'manual' })}
        >
          Sync
        </button>
      </div>

      {err && <Banner kind="danger">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}

      {docId && (
        <div className="card">
          <h3>This Google Doc</h3>
          <p className="sub" style={{ marginBottom: 10 }}>
            Formatting runs through the Docs API, with a preview first.
          </p>
          <div className="row wrap">
            <button
              className="btn primary small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await allowDoc(docId);
                  setPlan(await previewFormatting(docId));
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Preview fixes
            </button>
            <button className="btn small" onClick={() => openDashboard('#/docs')}>
              Open full formatter
            </button>
          </div>

          {plan && (
            <div style={{ marginTop: 12 }}>
              <Pill>{plan.fixes.length} change(s)</Pill>
              <ul className="sub" style={{ paddingLeft: 18, marginTop: 8 }}>
                {plan.fixes.slice(0, 8).map((f, i) => (
                  <li key={i}>{f.label}</li>
                ))}
              </ul>
              {plan.fixes.length > 0 && (
                <button
                  className="btn primary small"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await applyFormatting(plan);
                      setMsg(`Applied ${r.applied} edits.`);
                      setPlan(null);
                    } catch (e) {
                      setErr((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Apply
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {course && (
        <div className="card">
          <div className="row">
            <span className="course-dot" style={{ background: course.colour }} />
            <strong>{course.code}</strong>
          </div>
          <p className="sub">{course.teacher}</p>
        </div>
      )}

      {next && (
        <div className="card">
          <h3>Do this next</h3>
          <div style={{ fontWeight: 600 }}>{next.item.title}</div>
          <p className="sub">{next.why}</p>
          {next.item.url && (
            <a className="btn small primary" href={next.item.url} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
        </div>
      )}

      <div className="card">
        <h3>{course ? 'Open in this course' : 'Top priorities'}</h3>
        {courseItems.length ? (
          courseItems.map((i) => (
            <div className="checkline" key={i.id}>
              <input
                type="checkbox"
                checked={!!i.completed}
                onChange={async () => {
                  await db.items.update(i.id, { completed: !i.completed });
                  window.dispatchEvent(new Event('school-helper:data'));
                }}
              />
              <span className="text" style={{ flex: 1, fontSize: 13 }}>
                {i.title}
                <br />
                <span className="sub" style={{ fontSize: 11 }}>
                  {formatDue(effectiveDue(i))}
                </span>
              </span>
              <Pill>{priorityOf(i).score}</Pill>
            </div>
          ))
        ) : (
          <Empty>Nothing open.</Empty>
        )}
      </div>

      <div className="row wrap">
        <button className="btn small" onClick={() => openDashboard('#/today')}>
          Dashboard
        </button>
        <button className="btn small" onClick={() => openDashboard('#/notes')}>
          Answer notes
        </button>
        <button className="btn small" onClick={() => openDashboard('#/rubric')}>
          Rubric check
        </button>
      </div>
    </div>
  );
}
