import { useCallback, useEffect, useMemo, useState } from 'react';
import { db, getSettings, saveSettings } from '../common/db';
import type {
  ChangeRecord,
  Course,
  Rubric,
  Settings,
  SyncRun,
  TeacherQuestion,
  WorkItem,
} from '../common/types';

/** Re-runs the query whenever any table changes. Dexie has no hooks package here,
 *  so we poll a cheap change counter plus listen for our own broadcast events. */
export function useLive<T>(query: () => Promise<T>, deps: unknown[] = [], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  const run = useCallback(() => {
    let cancelled = false;
    query()
      .then((v) => !cancelled && setValue(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const cleanup = run();
    const onChange = () => run();
    window.addEventListener('school-helper:data', onChange);
    const id = setInterval(run, 5000);
    return () => {
      cleanup?.();
      window.removeEventListener('school-helper:data', onChange);
      clearInterval(id);
    };
  }, [run]);

  return value;
}

export function notifyDataChanged(): void {
  window.dispatchEvent(new Event('school-helper:data'));
}

export function useCourses(): Course[] {
  return useLive(() => db.courses.toArray(), [], []);
}

export function useItems(): WorkItem[] {
  return useLive(() => db.items.toArray(), [], []);
}

export function useQuestions(): TeacherQuestion[] {
  return useLive(() => db.questions.toArray(), [], []);
}

export function useRubrics(): Rubric[] {
  return useLive(() => db.rubrics.toArray(), [], []);
}

export function useChanges(): ChangeRecord[] {
  return useLive(
    async () => (await db.changes.orderBy('at').reverse().limit(300).toArray()) ?? [],
    [],
    [],
  );
}

export function useSyncs(): SyncRun[] {
  return useLive(
    async () => (await db.syncs.orderBy('startedAt').reverse().limit(25).toArray()) ?? [],
    [],
    [],
  );
}

export function useSettings(): [Settings | null, (patch: Partial<Settings>) => Promise<void>] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);
  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    notifyDataChanged();
  }, []);
  return [settings, update];
}

/** Hash router: #/today, #/course/ldsb:29940528, … */
export function useRoute(): [string, (r: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash || '#/today');
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || '#/today');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((route: string) => {
    window.location.hash = route.startsWith('#') ? route : `#${route}`;
  }, []);
  return [hash, navigate];
}

export function useTheme(pref: Settings['theme'] | undefined): void {
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = pref === 'dark' || (pref !== 'light' && mql.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [pref]);
}

export function useCourseMap(courses: Course[]): Map<string, Course> {
  return useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);
}
