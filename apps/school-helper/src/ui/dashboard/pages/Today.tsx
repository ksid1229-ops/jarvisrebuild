import { useMemo, useState } from 'react';
import { db } from '../../../common/db';
import {
  bucketOf,
  isDone,
  nextUp,
  priorityOf,
  weekendPlan,
  type Bucket,
} from '../../../common/priority';
import { applyOverride } from '../../../common/merge';
import type { Course, WorkItem } from '../../../common/types';
import { Banner, Empty, ItemRow, Pill } from '../../components/common';
import { notifyDataChanged, useCourseMap, useCourses, useItems, useLive } from '../../hooks';
import { linkWarning } from '../../../jarvis/link';
import { buildDaySummary } from '../../../ai/helpers';

const ORDER: { key: Bucket; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'this-week', label: 'This week' },
];

/** Surfaces a repeatedly-failing or lossy Jarvis link on the main page. */
function JarvisWarning(): JSX.Element | null {
  const warning = useLive<string | null>(() => linkWarning(), [], null);
  if (!warning) return null;
  return (
    <Banner kind="warn">
      {warning} <a href="#settings">Open Settings</a> to see the link log.
    </Banner>
  );
}

export function Today({ onOpen }: { onOpen: (item: WorkItem) => void }) {
  const items = useItems();
  const courses = useCourses();
  const courseMap = useCourseMap(courses);
  const [showPlan, setShowPlan] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<Bucket, WorkItem[]>();
    for (const item of items) {
      const b = bucketOf(item);
      if (!map.has(b)) map.set(b, []);
      map.get(b)!.push(item);
    }
    for (const list of map.values()) list.sort((a, b) => priorityOf(b).score - priorityOf(a).score);
    return map;
  }, [items]);

  const next = useMemo(() => nextUp(items), [items]);
  const plan = useMemo(() => weekendPlan(items), [items]);
  const open = items.filter((i) => !isDone(i));

  const toggle = async (item: WorkItem) => {
    await db.items.put(
      applyOverride({ ...item, completed: !item.completed }, 'completed', !item.completed),
    );
    notifyDataChanged();
  };

  return (
    <>
      <JarvisWarning />
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <p className="sub">
            {open.length} open item{open.length === 1 ? '' : 's'} across {courses.length} courses
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setShowPlan((v) => !v)}>
            {showPlan ? 'Hide' : 'Show'} weekend plan
          </button>
          <button className="btn" onClick={() => setSummary(buildDaySummary(items, courses))}>
            End-of-day summary
          </button>
        </div>
      </div>

      {next && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <div className="row spread wrap">
            <div>
              <h2 style={{ marginBottom: 2 }}>Do this next</h2>
              <div style={{ fontWeight: 600 }}>{next.item.title}</div>
              <p className="sub">
                {courseMap.get(next.item.courseId)?.code} · {next.why}
              </p>
            </div>
            <div className="row">
              {next.item.url && (
                <a className="btn primary" href={next.item.url} target="_blank" rel="noreferrer">
                  Open in D2L
                </a>
              )}
              <button className="btn" onClick={() => onOpen(next.item)}>
                Details
              </button>
            </div>
          </div>
        </div>
      )}

      {summary && (
        <div className="card">
          <div className="row spread">
            <h2>End-of-day summary</h2>
            <button className="btn small ghost" onClick={() => setSummary(null)}>
              ✕
            </button>
          </div>
          <pre className="notes-output">{summary}</pre>
        </div>
      )}

      {showPlan && (
        <div className="card">
          <h2>Weekend plan</h2>
          <p className="sub">Highest-priority open work, balanced across the two days.</p>
          <div className="grid two" style={{ marginTop: 12 }}>
            {plan.map((slot) => (
              <div key={slot.label}>
                <h3>
                  {slot.label} <Pill>load {slot.totalScore}</Pill>
                </h3>
                {slot.items.length ? (
                  slot.items.map((i) => (
                    <ItemRow
                      key={i.id}
                      item={i}
                      course={courseMap.get(i.courseId)}
                      onOpen={onOpen}
                      onToggle={toggle}
                    />
                  ))
                ) : (
                  <Empty>Nothing scheduled.</Empty>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {ORDER.map(({ key, label }) => {
        const list = grouped.get(key) ?? [];
        if (!list.length) return null;
        return (
          <section key={key} style={{ marginBottom: 22 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>{label}</h2>
              <Pill kind={key === 'overdue' ? 'overdue' : key === 'today' ? 'today' : undefined}>
                {list.length}
              </Pill>
            </div>
            {list.map((i) => (
              <ItemRow
                key={i.id}
                item={i}
                course={courseMap.get(i.courseId)}
                onOpen={onOpen}
                onToggle={toggle}
              />
            ))}
          </section>
        );
      })}

      {!items.length && (
        <Banner kind="info">
          Nothing here yet. Run a sync from the sidebar, or import your tracker markdown files from{' '}
          <a href="#/import">Import</a>.
        </Banner>
      )}

      <NoDateSection
        items={grouped.get('no-date') ?? []}
        courseMap={courseMap}
        onOpen={onOpen}
        onToggle={toggle}
      />
    </>
  );
}

function NoDateSection({
  items,
  courseMap,
  onOpen,
  onToggle,
}: {
  items: WorkItem[];
  courseMap: Map<string, Course>;
  onOpen: (i: WorkItem) => void;
  onToggle: (i: WorkItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const relevant = items.filter(
    (i) => i.kind === 'assignment' || i.kind === 'quiz' || i.kind === 'discussion',
  );
  if (!relevant.length) return null;
  return (
    <section>
      <button className="btn small" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Show'} {relevant.length} item{relevant.length === 1 ? '' : 's'} with no
        due date
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {relevant.map((i) => (
            <ItemRow
              key={i.id}
              item={i}
              course={courseMap.get(i.courseId)}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}
