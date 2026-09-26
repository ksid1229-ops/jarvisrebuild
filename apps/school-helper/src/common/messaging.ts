import type { BoardId, ChangeRecord, SyncRun } from './types';

/** Typed message bus between the dashboard, side panel, content scripts and the worker. */
export type Message =
  | { type: 'sync:start'; boards?: BoardId[]; courseIds?: string[]; trigger: SyncRun['trigger'] }
  | { type: 'sync:status' }
  | { type: 'sync:progress'; message: string; pct: number }
  | { type: 'sync:done'; run: SyncRun; changes: ChangeRecord[] }
  | { type: 'sync:error'; error: string }
  | { type: 'open:dashboard'; route?: string }
  | { type: 'open:sidepanel' }
  | { type: 'notify:test' }
  | { type: 'reminders:reschedule' }
  | { type: 'day-summary:now' }
  | {
      type: 'page:context';
      url: string;
      kind: 'd2l' | 'gdocs' | 'other';
      docId?: string;
      orgUnitId?: string;
    }
  | { type: 'gdocs:preview'; docId: string }
  | { type: 'gdocs:apply'; docId: string }
  | { type: 'gdocs:undo'; undoId: string }
  | { type: 'fixtures:export' }
  | { type: 'jarvis:pair'; deviceLabel: string }
  | { type: 'jarvis:check' }
  | { type: 'jarvis:flush' }
  | { type: 'jarvis:push' }
  | { type: 'jarvis:pull' };

export interface SyncStatus {
  running: boolean;
  message: string;
  pct: number;
  lastRun?: SyncRun;
}

export function send<T = unknown>(msg: Message): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(res as T);
    });
  });
}

export function broadcast(msg: Message): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
