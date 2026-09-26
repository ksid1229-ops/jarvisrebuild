import { useEffect, useState, type ReactNode } from 'react';
import type { Course, WorkItem } from '../../common/types';
import {
  DEADLINE_KINDS,
  bucketOf,
  effectiveDue,
  humanIn,
  isDone,
  priorityOf,
} from '../../common/priority';
import { describeCall, type Disclosure } from '../../ai';
import type { CompletionRequest } from '../../ai/provider';

export function Pill({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`pill ${kind ?? ''}`}>{children}</span>;
}

export function Banner({
  kind,
  children,
}: {
  kind: 'info' | 'warn' | 'danger' | 'ok';
  children: ReactNode;
}) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function formatDue(ms: number | null | undefined): string {
  if (ms == null) return 'No due date';
  const now = Date.now();
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  if (ms < now) return `${date} — ${humanIn(now - ms)} overdue`;
  return `${date}, ${time} (in ${humanIn(ms - now)})`;
}

/**
 * Honest date text for tiles that carry no deadlines (Content, Course Home).
 * Shows the availability window instead of due/overdue language.
 */
export function formatAvailability(item: WorkItem): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  if (item.startAt != null && item.endAt != null)
    return `${fmt(item.startAt)} \u2013 ${fmt(item.endAt)}`;
  if (item.endAt != null) return `until ${fmt(item.endAt)}`;
  if (item.startAt != null) return `from ${fmt(item.startAt)}`;
  if (item.dueAt != null) return `dated ${fmt(item.dueAt)}`;
  return 'No dates';
}

export function ItemRow({
  item,
  course,
  onOpen,
  onToggle,
}: {
  item: WorkItem;
  course?: Course;
  onOpen?: (item: WorkItem) => void;
  onToggle?: (item: WorkItem) => void;
}) {
  const p = priorityOf(item);
  const bucket = bucketOf(item);
  const due = effectiveDue(item);
  const done = isDone(item);

  return (
    <div className={`item ${done ? 'done' : ''}`}>
      <input
        type="checkbox"
        checked={!!item.completed || done}
        onChange={() => onToggle?.(item)}
        aria-label={`Mark ${item.title} complete`}
        style={{ marginTop: 4 }}
      />
      <div
        className={`score ${p.score >= 70 ? 'hot' : p.score >= 45 ? 'warm' : ''}`}
        title={p.reason}
      >
        {p.score}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="title">
          <button
            className="btn ghost"
            style={{ padding: 0, textAlign: 'left' }}
            onClick={() => onOpen?.(item)}
          >
            {item.title}
          </button>
        </div>
        <div className="meta">
          {course && (
            <span className="row" style={{ gap: 5 }}>
              <span className="course-dot" style={{ background: course.colour }} />
              {course.code}
            </span>
          )}
          <Pill>{item.kind}</Pill>
          <Pill kind={bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : undefined}>
            {DEADLINE_KINDS.has(item.kind) ? formatDue(due) : formatAvailability(item)}
          </Pill>
          {item.weight != null && <Pill>{item.weight}% of grade</Pill>}
          {item.points != null && <Pill>{item.points} pts</Pill>}
          {item.grade != null && (
            <Pill kind="ok">
              {item.grade}
              {item.gradeMax ? `/${item.gradeMax}` : ''}
            </Pill>
          )}
          {item.hiddenFromList && <Pill kind="today">hidden dropbox</Pill>}
          {item.overrides && Object.keys(item.overrides).length > 0 && (
            <Pill kind="accent">manual edit</Pill>
          )}
          {item.feedback && <Pill kind="accent">feedback</Pill>}
          {!item.presentInLastSync && <Pill>not in last sync</Pill>}
        </div>
      </div>
      {item.url && (
        <a className="btn small" href={item.url} target="_blank" rel="noreferrer">
          Open
        </a>
      )}
    </div>
  );
}

/**
 * Pre-call disclosure. Nothing reaches a provider until this is accepted —
 * enforced in provider.complete(), not just here.
 */
export function AiDisclosure({
  request,
  onConfirm,
  onCancel,
}: {
  request: CompletionRequest;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [info, setInfo] = useState<Disclosure | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    void describeCall(request).then(setInfo);
  }, [request]);

  if (!info) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>Send this to {info.isLocal ? 'your local model' : info.host}?</h2>
        <dl className="kv" style={{ margin: '14px 0' }}>
          <dt>Provider</dt>
          <dd>
            {info.providerLabel}{' '}
            {info.isLocal ? (
              <Pill kind="ok">stays on this PC</Pill>
            ) : (
              <Pill kind="today">leaves this PC</Pill>
            )}
          </dd>
          <dt>Endpoint</dt>
          <dd className="mono">{info.host}</dd>
          <dt>Model</dt>
          <dd className="mono">{info.model}</dd>
          <dt>Size</dt>
          <dd>~{info.approxPromptTokens.toLocaleString()} tokens</dd>
          <dt>Est. cost</dt>
          <dd>{info.isLocal ? '$0.00 (local)' : `~$${info.estimatedCostUsd.toFixed(4)}`}</dd>
        </dl>

        <button className="btn small" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? 'Hide' : 'Show'} exactly what is sent
        </button>
        {showPreview && (
          <pre
            className="notes-output mono"
            style={{ marginTop: 10, maxHeight: 260, overflow: 'auto' }}
          >
            {info.preview}
          </pre>
        )}

        <div className="row spread" style={{ marginTop: 18 }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={onConfirm}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row spread" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn small ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
