import { useCallback, useEffect, useState } from 'react';
import { db } from '../../../common/db';
import { send } from '../../../common/messaging';
import type { JarvisLogEntry, JarvisSettings } from '../../../common/types';
import { DEFAULT_JARVIS, FAILURE_WARNING_THRESHOLD } from '../../../jarvis/link';
import { Banner, Pill } from '../../components/common';
import { useLive, useSettings } from '../../hooks';

const STATUS_LABEL: Record<string, string> = {
  unpaired: 'Not paired',
  pending: 'Waiting for your approval in Telegram',
  active: 'Paired and active',
  expired: 'Pairing expired — pair again',
  'unavailable-or-refused': 'Gateway unavailable or refused',
};

function statusKind(status?: string): string {
  if (status === 'active') return 'ok';
  if (status === 'unavailable-or-refused') return 'danger';
  return 'warn';
}

/**
 * Settings → Jarvis link.
 *
 * The toggle is off by default and School Helper is fully usable with it off.
 * Nothing here can turn on sending without a completed pairing that Sid
 * approved in Telegram.
 */
export function JarvisLinkPanel(): JSX.Element {
  const [settings, save] = useSettings();
  const jarvis: JarvisSettings = { ...DEFAULT_JARVIS, ...(settings?.jarvis ?? {}) };
  const [label, setLabel] = useState('Home PC');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [queued, setQueued] = useState(0);

  const log = useLive<JarvisLogEntry[]>(
    () => db.jarvisLog.orderBy('at').reverse().limit(50).toArray() as Promise<JarvisLogEntry[]>,
    [],
    [],
  );

  const refreshQueue = useCallback(async () => setQueued(await db.jarvisOutbox.count()), []);
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue, log.length]);

  const patch = async (next: Partial<JarvisSettings>) => save({ jarvis: { ...jarvis, ...next } });

  /** Asks for host permission for the gateway origin before any call is made. */
  const requestOrigin = async (baseUrl: string): Promise<boolean> => {
    let origin: string;
    try {
      origin = `${new URL(baseUrl).origin}/*`;
    } catch {
      setMessage({ kind: 'bad', text: 'That is not a valid URL.' });
      return false;
    }
    if (!/^https:/.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
      setMessage({
        kind: 'bad',
        text: 'The gateway must be https, or http://localhost for testing.',
      });
      return false;
    }
    const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    if (!granted)
      setMessage({
        kind: 'bad',
        text: `Permission for ${origin} was not granted, so nothing can be sent.`,
      });
    return granted;
  };

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    try {
      await fn();
    } catch (error) {
      setMessage({ kind: 'bad', text: (error as Error).message });
    } finally {
      setBusy(null);
      void refreshQueue();
    }
  };

  const pair = () =>
    act('pair', async () => {
      if (!(await requestOrigin(jarvis.baseUrl))) return;
      const result = await send<{ code: string }>({ type: 'jarvis:pair', deviceLabel: label });
      setMessage({
        kind: 'ok',
        text: `Pairing started. Approve code ${result.code} in Jarvis on Telegram, then press "Check pairing".`,
      });
    });

  const check = () =>
    act('check', async () => {
      const result = await send<{ status: string }>({ type: 'jarvis:check' });
      setMessage({
        kind: result.status === 'active' ? 'ok' : 'bad',
        text: `Pairing is ${result.status}.`,
      });
    });

  const pushNow = () =>
    act('push', async () => {
      await send({ type: 'jarvis:push' });
      setMessage({
        kind: 'ok',
        text: 'Evidence read and queued. See the log below for what was sent.',
      });
    });

  const flush = () =>
    act('flush', async () => {
      const result = await send<{ sent: number; queued: number; error: string | null }>({
        type: 'jarvis:flush',
      });
      setMessage({
        kind: result.error ? 'bad' : 'ok',
        text: result.error
          ? `${result.error} — ${result.queued} still queued.`
          : `Sent ${result.sent}. Queue empty.`,
      });
    });

  const pullNow = () =>
    act('pull', async () => {
      const result = await send<{ pulled: number; ran: string[]; error: string | null } | null>({
        type: 'jarvis:pull',
      });
      setMessage({
        kind: result?.error ? 'bad' : 'ok',
        text: !result
          ? 'Link is off or unpaired.'
          : result.error
            ? result.error
            : `Checked: ${result.pulled} request(s), ran ${result.ran.length}.`,
      });
    });

  const paired = jarvis.pairing?.status === 'active';

  return (
    <div className="card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Jarvis link</h2>
        <Pill kind={statusKind(jarvis.pairing?.status)}>
          {STATUS_LABEL[jarvis.pairing?.status ?? 'unpaired']}
        </Pill>
      </div>

      <p className="sub" style={{ margin: '6px 0 14px' }}>
        Sends the raw D2L evidence School Helper reads to your Jarvis assistant, so Jarvis can
        answer questions about your schoolwork. Jarvis decides what matters — School Helper never
        sends its own priority scores, and never sends, posts or submits anything to D2L.
      </p>

      {jarvis.enabled && jarvis.failureStreak >= FAILURE_WARNING_THRESHOLD && (
        <Banner kind="danger">
          The link has failed {jarvis.failureStreak} times in a row. {queued} batch
          {queued === 1 ? '' : 'es'} queued.
        </Banner>
      )}
      {jarvis.droppedTotal > 0 && (
        <Banner kind="warn">
          {jarvis.droppedTotal} queued batch{jarvis.droppedTotal === 1 ? ' has' : 'es have'} been
          dropped to stay inside the 1 MiB queue cap. Those reads were never delivered.
        </Banner>
      )}
      {message && <Banner kind={message.kind === 'ok' ? 'ok' : 'danger'}>{message.text}</Banner>}

      <label className="row" style={{ marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={jarvis.enabled}
          onChange={async (e) => {
            if (e.target.checked && !(await requestOrigin(jarvis.baseUrl))) return;
            await patch({ enabled: e.target.checked });
          }}
        />
        <span>
          <strong>Send evidence to Jarvis</strong>
          <br />
          <span className="sub">
            Off by default. Everything else in School Helper works with this off.
          </span>
        </span>
      </label>

      <label className="field">
        <span>Gateway URL</span>
        <input
          type="url"
          value={jarvis.baseUrl}
          disabled={paired}
          placeholder="https://your-worker.workers.dev"
          onChange={(e) => void patch({ baseUrl: e.target.value })}
        />
      </label>
      <p className="sub" style={{ marginTop: 4 }}>
        {paired
          ? 'Locked while paired: the device key is bound to this gateway. Unpair to change it.'
          : 'Paste the URL wrangler shows after deploy (https, or http://localhost for testing). Permission is requested when you pair.'}
      </p>

      <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>This device</span>
          <input
            value={label}
            maxLength={64}
            disabled={paired}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <button className="btn primary" disabled={!!busy || paired} onClick={pair}>
          {busy === 'pair' ? 'Pairing…' : 'Save and pair'}
        </button>
        <button className="btn" disabled={!!busy || !jarvis.pairing} onClick={check}>
          {busy === 'check' ? 'Checking…' : 'Check pairing'}
        </button>
      </div>

      {jarvis.pairing?.code && !paired && (
        <p className="sub" style={{ marginTop: 10 }}>
          Approval code: <code className="mono">{jarvis.pairing.code}</code>
          {jarvis.pairing.expiresAt && (
            <> — expires {new Date(jarvis.pairing.expiresAt).toLocaleTimeString()}. </>
          )}
          Jarvis asks you to approve this in Telegram. The window is ten minutes; after that, pair
          again.
        </p>
      )}

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button className="btn" disabled={!!busy || !paired || !jarvis.enabled} onClick={pushNow}>
          {busy === 'push' ? 'Reading…' : 'Send evidence now'}
        </button>
        <button className="btn" disabled={!!busy || !paired} onClick={flush}>
          {busy === 'flush' ? 'Sending…' : `Retry queue (${queued})`}
        </button>
        <button className="btn" disabled={!!busy || !paired || !jarvis.enabled} onClick={pullNow}>
          {busy === 'pull' ? 'Checking…' : 'Check for Jarvis requests'}
        </button>
      </div>

      <h3 style={{ marginTop: 22, marginBottom: 6 }}>Link log — last 50 calls</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Exactly what left this browser. Nothing is marked sent unless Jarvis returned a receipt.
      </p>
      {log.length === 0 ? (
        <p className="sub">Nothing sent yet.</p>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Items</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {log.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{new Date(entry.at).toLocaleTimeString()}</td>
                  <td className="mono">{entry.endpoint}</td>
                  <td>
                    <Pill kind={entry.ok ? 'ok' : 'danger'}>{entry.status || '—'}</Pill>
                  </td>
                  <td>{entry.itemCount}</td>
                  <td className="sub">{entry.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
