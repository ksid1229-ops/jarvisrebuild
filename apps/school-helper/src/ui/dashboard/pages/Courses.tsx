import { useMemo, useState } from 'react';
import { db } from '../../../common/db';
import { applyOverride } from '../../../common/merge';
import { effectiveDue, isDone, priorityOf } from '../../../common/priority';
import { BOARDS } from '../../../common/settings';
import type { WorkItem } from '../../../common/types';
import { Empty, ItemRow, Pill } from '../../components/common';
import { notifyDataChanged, useCourses, useItems } from '../../hooks';

export function Courses({ onOpenCourse }: { onOpenCourse: (courseId: string) => void }) {
  const courses = useCourses();
  const items = useItems();

  const stats = useMemo(() => {
    const map = new Map<string, { total: number; open: number; overdue: number; graded: number }>();
    for (const c of courses) map.set(c.id, { total: 0, open: 0, overdue: 0, graded: 0 });
    const now = Date.now();
    for (const i of items) {
      const s = map.get(i.courseId);
      if (!s) continue;
      s.total++;
      if (!isDone(i)) {
        s.open++;
        const due = effectiveDue(i);
        if (due != null && due < now) s.overdue++;
      }
      if (i.grade != null) s.graded++;
    }
    return map;
  }, [courses, items]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Courses</h1>
          <p className="sub">
            Three courses across two boards. Durham is reached by SSO from LDSB.
          </p>
        </div>
      </div>

      <div className="grid three">
        {courses.map((c) => {
          const s = stats.get(c.id) ?? { total: 0, open: 0, overdue: 0, graded: 0 };
          return (
            <button
              key={c.id}
              className="card"
              style={{ textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onOpenCourse(c.id)}
            >
              <div className="row" style={{ marginBottom: 6 }}>
                <span
                  className="course-dot"
                  style={{ background: c.colour, width: 11, height: 11 }}
                />
                <strong>{c.code}</strong>
              </div>
              <div style={{ fontSize: 15, marginBottom: 2 }}>{c.name}</div>
              <p className="sub" style={{ marginBottom: 10 }}>
                {c.teacher} · {BOARDS[c.board].label}
              </p>
              <div className="row wrap">
                <Pill>{s.total} items</Pill>
                <Pill kind={s.open ? 'accent' : 'ok'}>{s.open} open</Pill>
                {s.overdue > 0 && <Pill kind="overdue">{s.overdue} overdue</Pill>}
                {s.graded > 0 && <Pill kind="ok">{s.graded} graded</Pill>}
              </div>
              <p className="sub" style={{ marginTop: 10, fontSize: 12 }}>
                ou {c.orgUnitId} ·{' '}
                {c.lastSyncedAt
                  ? `synced ${new Date(c.lastSyncedAt).toLocaleString('en-CA')}`
                  : 'never synced'}
              </p>
            </button>
          );
        })}
      </div>
    </>
  );
}

const KIND_ORDER: WorkItem['kind'][] = [
  'assignment',
  'quiz',
  'discussion',
  'unit',
  'lesson',
  'announcement',
  'other',
];

export function CourseDetail({
  courseId,
  onOpen,
}: {
  courseId: string;
  onOpen: (item: WorkItem) => void;
}) {
  const courses = useCourses();
  const items = useItems();
  const course = courses.find((c) => c.id === courseId);
  const [filter, setFilter] = useState<'all' | 'open' | 'graded'>('open');

  const mine = useMemo(() => {
    let list = items.filter((i) => i.courseId === courseId);
    if (filter === 'open') list = list.filter((i) => !isDone(i));
    if (filter === 'graded') list = list.filter((i) => i.grade != null || i.feedback);
    return list.sort((a, b) => priorityOf(b).score - priorityOf(a).score);
  }, [items, courseId, filter]);

  const byKind = useMemo(() => {
    const map = new Map<WorkItem['kind'], WorkItem[]>();
    for (const i of mine) {
      if (!map.has(i.kind)) map.set(i.kind, []);
      map.get(i.kind)!.push(i);
    }
    return map;
  }, [mine]);

  const toggle = async (item: WorkItem) => {
    await db.items.put(
      applyOverride({ ...item, completed: !item.completed }, 'completed', !item.completed),
    );
    notifyDataChanged();
  };

  if (!course) return <Empty>Course not found.</Empty>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row">
            <span
              className="course-dot"
              style={{ background: course.colour, width: 12, height: 12 }}
            />
            <h1 style={{ margin: 0 }}>
              {course.code} — {course.name}
            </h1>
          </div>
          <p className="sub">
            {course.teacher} · {BOARDS[course.board].label} · org unit {course.orgUnitId}
          </p>
        </div>
        <div className="row">
          {(['open', 'all', 'graded'] as const).map((f) => (
            <button
              key={f}
              className={`btn small ${filter === f ? 'primary' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {course.weights && Object.keys(course.weights).length > 0 && (
        <div className="card">
          <h2>Evaluation weights</h2>
          <table className="data">
            <tbody>
              {Object.entries(course.weights).map(([name, w]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td style={{ width: 80, textAlign: 'right' }}>{w}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {KIND_ORDER.filter((k) => byKind.has(k)).map((kind) => (
        <section key={kind} style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0, textTransform: 'capitalize' }}>{kind}s</h2>
            <Pill>{byKind.get(kind)!.length}</Pill>
          </div>
          {byKind.get(kind)!.map((i) => (
            <ItemRow key={i.id} item={i} course={course} onOpen={onOpen} onToggle={toggle} />
          ))}
        </section>
      ))}

      {!mine.length && <Empty>No items match this filter. Try “all”, or run a sync.</Empty>}
    </>
  );
}
