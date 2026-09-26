import { useEffect, useState } from 'react';
import { db, exportAll, importAll } from '../../../common/db';
import { decryptSecret, encryptSecret, maskKey } from '../../../common/crypto';
import { isLocalEndpoint } from '../../../common/settings';
import type { AiProviderConfig, AiRole } from '../../../common/types';
import { complete, monthKey, monthlySpend } from '../../../ai';
import { exportFixtures, clearFixtures } from '../../../d2l/capture';
import { expectedRedirectUri, isSignedIn, signIn, signOut } from '../../../gdocs/auth';
import { Banner, Pill } from '../../components/common';
import { JarvisLinkPanel } from './JarvisLink';
import { notifyDataChanged, useSettings } from '../../hooks';

const PRESETS: {
  label: string;
  kind: AiProviderConfig['kind'];
  baseUrl: string;
  model: string;
  in: number;
  out: number;
}[] = [
  {
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    in: 0.27,
    out: 1.1,
  },
  {
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    in: 2.5,
    out: 10,
  },
  {
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    in: 0.15,
    out: 0.6,
  },
  {
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    in: 3,
    out: 15,
  },
  {
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    in: 0,
    out: 0,
  },
  {
    label: 'LM Studio (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    in: 0,
    out: 0,
  },
];

export function SettingsPage() {
  const [settings, update] = useSettings();
  const [spend, setSpend] = useState({ usd: 0, calls: 0, tokens: 0 });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [googleOn, setGoogleOn] = useState(false);
  const [fixtureCount, setFixtureCount] = useState(0);

  useEffect(() => {
    void monthlySpend().then(setSpend);
    void isSignedIn()
      .then(setGoogleOn)
      .catch(() => setGoogleOn(false));
    void db.fixtures.count().then(setFixtureCount);
  }, [settings]);

  if (!settings) return null;

  const setProvider = async (role: AiRole, patch: Partial<AiProviderConfig>) => {
    await update({
      providers: { ...settings.providers, [role]: { ...settings.providers[role], ...patch } },
    });
  };

  const download = (name: string, content: string, type = 'application/json') => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Everything on this page stays on this PC.</p>
        </div>
      </div>

      {msg && <Banner kind="ok">{msg}</Banner>}
      {err && <Banner kind="danger">{err}</Banner>}

      <div className="card">
        <h2>Appearance</h2>
        <div className="row">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              className={`btn small ${settings.theme === t ? 'primary' : ''}`}
              onClick={() => void update({ theme: t })}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row spread">
          <h2 style={{ margin: 0 }}>AI providers</h2>
          <Pill kind={settings.localModelOnly ? 'ok' : undefined}>
            {monthKey()} · ${spend.usd.toFixed(3)} over {spend.calls} calls
          </Pill>
        </div>
        <p className="sub" style={{ margin: '6px 0 14px' }}>
          Bring any API. Keys are encrypted with a device key and never logged or exported by
          default.
        </p>

        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.localModelOnly}
            onChange={(e) => void update({ localModelOnly: e.target.checked })}
          />
          <span>
            <strong>Local model only</strong> — block every call to an endpoint that is not on this
            machine
          </span>
        </label>
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.confirmBeforeAiCall}
            onChange={(e) => void update({ confirmBeforeAiCall: e.target.checked })}
          />
          <span>Show me what is being sent, and to whom, before each call</span>
        </label>
        <label className="field" style={{ maxWidth: 240 }}>
          <span>Monthly budget (USD, blank = no cap)</span>
          <input
            type="number"
            step="1"
            value={settings.monthlyBudgetUsd ?? ''}
            onChange={(e) =>
              void update({
                monthlyBudgetUsd: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>

        {(['cheap', 'strong'] as AiRole[]).map((role) => (
          <ProviderCard
            key={role}
            role={role}
            config={settings.providers[role]}
            onChange={(patch) => void setProvider(role, patch)}
            onError={setErr}
            onMessage={setMsg}
          />
        ))}
      </div>

      <JarvisLinkPanel />

      <div className="card">
        <h2>Google Docs</h2>
        <p className="sub" style={{ marginBottom: 12 }}>
          Needed for the worksheet formatter and “copy to my Drive”. You create the OAuth client ID
          yourself — the README has the steps. Scope is limited to documents you explicitly approve.
        </p>
        <label className="field">
          <span>OAuth client ID</span>
          <input
            type="text"
            value={settings.google.clientId}
            placeholder="1234567890-abc123.apps.googleusercontent.com"
            onChange={(e) =>
              void update({ google: { ...settings.google, clientId: e.target.value.trim() } })
            }
          />
        </label>
        <p className="sub">
          Authorised redirect URI to paste into Google Cloud:{' '}
          <code className="mono">{expectedRedirectUri()}</code>
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await signIn(true);
                setGoogleOn(true);
                setMsg('Signed in to Google.');
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            {googleOn ? 'Re-authorise' : 'Sign in to Google'}
          </button>
          {googleOn && (
            <button
              className="btn"
              onClick={async () => {
                await signOut();
                setGoogleOn(false);
              }}
            >
              Sign out
            </button>
          )}
          <Pill kind={googleOn ? 'ok' : undefined}>{googleOn ? 'connected' : 'not connected'}</Pill>
        </div>
        {settings.google.allowedDocIds.length > 0 && (
          <p className="sub" style={{ marginTop: 10 }}>
            {settings.google.allowedDocIds.length} document
            {settings.google.allowedDocIds.length === 1 ? '' : 's'} approved.{' '}
            <button
              className="btn small"
              onClick={() => void update({ google: { ...settings.google, allowedDocIds: [] } })}
            >
              Revoke all
            </button>
          </p>
        )}
      </div>

      <div className="card">
        <h2>Sync</h2>
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.sync.onBrowse}
            onChange={(e) =>
              void update({ sync: { ...settings.sync, onBrowse: e.target.checked } })
            }
          />
          <span>Sync quietly while I browse D2L (at most once every 10 minutes)</span>
        </label>
        <label className="field" style={{ maxWidth: 240 }}>
          <span>Background sync interval (minutes, 0 = off)</span>
          <input
            type="number"
            value={settings.sync.intervalMinutes}
            onChange={(e) =>
              void update({ sync: { ...settings.sync, intervalMinutes: Number(e.target.value) } })
            }
          />
        </label>
        <Banner kind="info">
          Sync is strictly read-only. It only ever issues GET requests, and never submits, posts, or
          marks anything as read.
        </Banner>
      </div>

      <div className="card">
        <h2>Reminders</h2>
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.reminders.enabled}
            onChange={(e) =>
              void update({ reminders: { ...settings.reminders, enabled: e.target.checked } })
            }
          />
          <span>Desktop notifications before due dates</span>
        </label>
        <label className="field" style={{ maxWidth: 320 }}>
          <span>Lead times (hours, comma separated)</span>
          <input
            type="text"
            value={settings.reminders.leadHours.join(', ')}
            onChange={(e) =>
              void update({
                reminders: {
                  ...settings.reminders,
                  leadHours: e.target.value
                    .split(',')
                    .map((v) => Number(v.trim()))
                    .filter((n) => Number.isFinite(n) && n > 0),
                },
              })
            }
          />
        </label>
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.reminders.endOfDaySummary}
            onChange={(e) =>
              void update({
                reminders: { ...settings.reminders, endOfDaySummary: e.target.checked },
              })
            }
          />
          <span>End-of-day summary at {settings.reminders.endOfDayHour}:00</span>
        </label>
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              chrome.runtime
                .sendMessage({ type: 'reminders:reschedule' })
                .then(() => setMsg('Reminders rescheduled.'))
            }
          >
            Reschedule now
          </button>
          <button
            className="btn"
            onClick={() => chrome.runtime.sendMessage({ type: 'notify:test' })}
          >
            Test notification
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Backup and restore</h2>
        <p className="sub" style={{ marginBottom: 12 }}>
          Everything lives in IndexedDB on this PC. Export regularly — there is no cloud copy.
        </p>
        <div className="row wrap">
          <button
            className="btn primary"
            onClick={async () =>
              download(
                `school-helper-backup-${new Date().toISOString().slice(0, 10)}.json`,
                await exportAll(false),
              )
            }
          >
            Export backup
          </button>
          <button
            className="btn"
            onClick={async () => {
              if (!confirm('This export INCLUDES your API keys in encrypted form. Continue?'))
                return;
              download(`school-helper-backup-with-keys-${Date.now()}.json`, await exportAll(true));
            }}
          >
            Export including keys
          </button>
          <label className="btn" style={{ cursor: 'pointer' }}>
            Import backup
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const result = await importAll(await file.text(), 'merge');
                if (result.ok) {
                  setMsg(
                    `Imported: ${Object.entries(result.counts)
                      .map(([k, v]) => `${v} ${k}`)
                      .join(', ')}`,
                  );
                  notifyDataChanged();
                } else setErr(result.error ?? 'Import failed.');
              }}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Debug fixtures</h2>
        <p className="sub" style={{ marginBottom: 12 }}>
          Saves the D2L responses from your real session, with names, emails and student numbers
          stripped out, so the parsers can be hardened against the live shapes. Off by default.
        </p>
        <label className="row" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={settings.captureFixtures}
            onChange={(e) => void update({ captureFixtures: e.target.checked })}
          />
          <span>Capture debug fixtures on the next sync</span>
        </label>
        <div className="row wrap">
          <Pill>{fixtureCount} captured</Pill>
          <button
            className="btn"
            disabled={!fixtureCount}
            onClick={async () =>
              download(`school-helper-fixtures-${Date.now()}.json`, await exportFixtures())
            }
          >
            Export fixtures
          </button>
          <button
            className="btn danger"
            disabled={!fixtureCount}
            onClick={async () => {
              await clearFixtures();
              setFixtureCount(0);
            }}
          >
            Delete captured fixtures
          </button>
        </div>
      </div>
    </>
  );
}

function ProviderCard({
  role,
  config,
  onChange,
  onError,
  onMessage,
}: {
  role: AiRole;
  config: AiProviderConfig;
  onChange: (patch: Partial<AiProviderConfig>) => void;
  onError: (m: string) => void;
  onMessage: (m: string) => void;
}) {
  const [keyInput, setKeyInput] = useState('');
  const [existing, setExisting] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void decryptSecret(config.apiKeyCipher).then(setExisting);
  }, [config.apiKeyCipher]);

  const local = config.isLocal || isLocalEndpoint(config.baseUrl);

  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="row spread" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          {role === 'cheap' ? 'Cheap model' : 'Strong model'}{' '}
          <span className="sub">
            {role === 'cheap'
              ? '— sync summaries, tracker updates'
              : '— rubric checks, essay feedback'}
          </span>
        </h3>
        {local && <Pill kind="ok">local</Pill>}
      </div>

      <div className="row wrap" style={{ marginBottom: 10 }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className="btn small"
            onClick={() =>
              onChange({
                kind: p.kind,
                baseUrl: p.baseUrl,
                model: p.model,
                isLocal: isLocalEndpoint(p.baseUrl),
                inputCostPerMTok: p.in,
                outputCostPerMTok: p.out,
              })
            }
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 10 }}>
        <label className="field" style={{ flex: 2 }}>
          <span>Base URL</span>
          <input
            type="url"
            value={config.baseUrl}
            onChange={(e) =>
              onChange({ baseUrl: e.target.value, isLocal: isLocalEndpoint(e.target.value) })
            }
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Format</span>
          <select
            value={config.kind}
            onChange={(e) => onChange({ kind: e.target.value as AiProviderConfig['kind'] })}
          >
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
      </div>

      <div className="row" style={{ gap: 10 }}>
        <label className="field" style={{ flex: 2 }}>
          <span>Model</span>
          <input
            type="text"
            value={config.model}
            onChange={(e) => onChange({ model: e.target.value })}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>$ / M input</span>
          <input
            type="number"
            step="0.01"
            value={config.inputCostPerMTok ?? 0}
            onChange={(e) => onChange({ inputCostPerMTok: Number(e.target.value) })}
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>$ / M output</span>
          <input
            type="number"
            step="0.01"
            value={config.outputCostPerMTok ?? 0}
            onChange={(e) => onChange({ outputCostPerMTok: Number(e.target.value) })}
          />
        </label>
      </div>

      <label className="field">
        <span>API key — currently {maskKey(existing)}</span>
        <div className="row">
          <input
            type="password"
            value={keyInput}
            placeholder="paste a new key to replace it"
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button
            className="btn"
            disabled={!keyInput}
            onClick={async () => {
              onChange({ apiKeyCipher: await encryptSecret(keyInput) });
              setKeyInput('');
              onMessage('Key saved, encrypted on this device.');
            }}
          >
            Save key
          </button>
          {existing && (
            <button className="btn danger small" onClick={() => onChange({ apiKeyCipher: '' })}>
              Remove
            </button>
          )}
        </div>
      </label>

      <button
        className="btn small"
        disabled={testing}
        onClick={async () => {
          setTesting(true);
          try {
            const out = await complete({
              role,
              feature: 'other',
              maxTokens: 20,
              disclosureAccepted: true,
              messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
            });
            onMessage(
              `${role} model replied: "${out.text.trim().slice(0, 40)}" (~$${out.estimatedCostUsd.toFixed(5)})`,
            );
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setTesting(false);
          }
        }}
      >
        {testing ? 'Testing…' : 'Test this model'}
      </button>
    </div>
  );
}
