import { useEffect, useState } from 'react';
import type { WorkItem } from '../../common/types';
import { Pill } from '../components/common';
import {
  useChanges,
  useCourses,
  useItems,
  useRoute,
  useRubrics,
  useSettings,
  useTheme,
} from '../hooks';
import { Today } from './pages/Today';
import { CourseDetail, Courses } from './pages/Courses';
import { ItemDetail } from './pages/ItemDetail';
import { Scribe } from './pages/Scribe';
import { AnswerNotesPage, QuestionsPage, RubricCheckPage } from './pages/AiPages';
import { ChangesPage, DocsFormatterPage, ImportPage, WelcomePage } from './pages/Misc';
import { SettingsPage } from './pages/Settings';
import { isDone } from '../../common/priority';
import '../../ai';

interface SyncState {
  running: boolean;
  message: string;
  pct: number;
}

export function App() {
  const [route, navigate] = useRoute();
  const [settings] = useSettings();
  const courses = useCourses();
  const items = useItems();
  const rubrics = useRubrics();
  const changes = useChanges();
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [scribeItem, setScribeItem] = useState<WorkItem | null>(null);
  const [sync, setSync] = useState<SyncState>({ running: false, message: 'Idle', pct: 0 });

  useTheme(settings?.theme);

  useEffect(() => {
    const listener = (msg: { type?: string; message?: string; pct?: number; error?: string }) => {
      if (msg.type === 'sync:progress')
        setSync({ running: true, message: msg.message ?? '', pct: msg.pct ?? 0 });
      if (msg.type === 'sync:done') setSync({ running: false, message: 'Up to date', pct: 100 });
      if (msg.type === 'sync:error')
        setSync({ running: false, message: msg.error ?? 'Sync failed', pct: 0 });
    };
    chrome.runtime?.onMessage.addListener(listener);
    return () => chrome.runtime?.onMessage.removeListener(listener);
  }, []);

  const startSync = () => {
    setSync({ running: true, message: 'Starting…', pct: 1 });
    chrome.runtime
      .sendMessage({ type: 'sync:start', trigger: 'manual' })
      .catch((e: Error) => setSync({ running: false, message: e.message, pct: 0 }));
  };

  const openItem = (item: WorkItem) => setSelected(item);
  const unseen = changes.filter((c) => !c.seen).length;
  const openCount = items.filter((i) => !isDone(i)).length;

  const nav = (r: string, label: string, badge?: number) => (
    <button
      key={r}
      className={`nav-item ${route.startsWith(r) ? 'active' : ''}`}
      onClick={() => navigate(r)}
    >
      <span>{label}</span>
      {badge ? <Pill kind={r === '#/changes' ? 'accent' : undefined}>{badge}</Pill> : null}
    </button>
  );

  let page: React.ReactNode;
  if (route.startsWith('#/course/'))
    page = (
      <CourseDetail
        courseId={decodeURIComponent(route.slice('#/course/'.length))}
        onOpen={openItem}
      />
    );
  else if (route.startsWith('#/courses'))
    page = <Courses onOpenCourse={(id) => navigate(`#/course/${encodeURIComponent(id)}`)} />;
  else if (route.startsWith('#/questions')) page = <QuestionsPage />;
  else if (route.startsWith('#/notes'))
    page = <AnswerNotesPage preselect={selected ?? undefined} />;
  else if (route.startsWith('#/rubric'))
    page = <RubricCheckPage preselect={selected ?? undefined} />;
  else if (route.startsWith('#/docs')) page = <DocsFormatterPage />;
  else if (route.startsWith('#/changes')) page = <ChangesPage />;
  else if (route.startsWith('#/import')) page = <ImportPage />;
  else if (route.startsWith('#/settings')) page = <SettingsPage />;
  else if (route.startsWith('#/welcome')) page = <WelcomePage go={navigate} />;
  else page = <Today onOpen={openItem} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot">✓</span> School Helper
        </div>

        <button
          className="btn primary"
          onClick={startSync}
          disabled={sync.running}
          style={{ marginBottom: 8 }}
        >
          {sync.running ? 'Syncing…' : 'Sync now'}
        </button>
        {sync.running && (
          <>
            <div className="progress">
              <div style={{ width: `${sync.pct}%` }} />
            </div>
            <p className="sub" style={{ fontSize: 11, padding: '4px 10px 0' }}>
              {sync.message}
            </p>
          </>
        )}
        {!sync.running && sync.message !== 'Idle' && (
          <p className="sub" style={{ fontSize: 11, padding: '0 10px 6px' }}>
            {sync.message}
          </p>
        )}

        <div className="nav-section">Tracker</div>
        {nav('#/today', 'Today', openCount)}
        {nav('#/courses', 'Courses', courses.length)}
        {nav('#/changes', 'What changed', unseen)}
        {nav('#/questions', 'Teacher questions')}

        <div className="nav-section">Work on something</div>
        {nav('#/notes', 'Answer notes')}
        {nav('#/rubric', 'Rubric check')}
        {nav('#/docs', 'Worksheet formatter')}

        <div className="nav-section">Setup</div>
        {nav('#/import', 'Import tracker files')}
        {nav('#/settings', 'Settings')}

        <div style={{ flex: 1 }} />
        <p className="sub" style={{ fontSize: 11, padding: '0 10px' }}>
          All data is stored locally. Sync is read-only.
        </p>
      </aside>

      <main className="main">
        {scribeItem ? <Scribe item={scribeItem} onClose={() => setScribeItem(null)} /> : page}
      </main>

      {selected && (
        <ItemDetail
          item={selected}
          course={courses.find((c) => c.id === selected.courseId)}
          rubrics={rubrics}
          onClose={() => setSelected(null)}
          onAnswerNotes={(i) => {
            setSelected(i);
            navigate('#/notes');
            setSelected(null);
          }}
          onRubricCheck={(i) => {
            setSelected(i);
            navigate('#/rubric');
            setSelected(null);
          }}
          onScribe={(i) => {
            setScribeItem(i);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}
