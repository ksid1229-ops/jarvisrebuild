import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScribeAnswer, ScribeDiff, ScribeSession, WorkItem } from '../../../common/types';
import { cleanupAnswer } from '../../../scribe/cleanup';
import { isSpeechAvailable, startDictation } from '../../../scribe/speech';
import type { Dictation } from '../../../scribe/speech';
import {
  exportAsText,
  loadSession,
  promptsFromPaste,
  saveAnswer,
  startSession,
} from '../../../scribe/session';
import { Banner, Pill } from '../../components/common';

/** Renders the raw/cleaned comparison with every added word marked. */
function DiffView({ diff }: { diff: ScribeDiff }): JSX.Element {
  return (
    <div>
      <p style={{ lineHeight: 1.9, margin: '0 0 10px' }}>
        {diff.tokens.map((token, index) => {
          if (token.kind === 'removed') {
            return (
              <span
                key={index}
                title={token.meaningful ? 'Removed' : 'Filler, removed'}
                style={{ textDecoration: 'line-through', opacity: 0.45, marginRight: 4 }}
              >
                {token.text}
              </span>
            );
          }
          if (token.kind === 'added' && token.meaningful) {
            return (
              <mark
                key={index}
                style={{
                  background: '#ffd9d9',
                  color: '#7a1010',
                  padding: '1px 3px',
                  borderRadius: 3,
                  marginRight: 4,
                  fontWeight: 600,
                }}
              >
                {token.text}
              </mark>
            );
          }
          return (
            <span
              key={index}
              style={{ marginRight: 4, opacity: token.kind === 'added' ? 0.75 : 1 }}
            >
              {token.text}
            </span>
          );
        })}
      </p>
    </div>
  );
}

function AnswerEditor({
  prompt,
  index,
  total,
  existing,
  onSaved,
}: {
  prompt: { id: string; text: string };
  index: number;
  total: number;
  existing?: ScribeAnswer;
  onSaved: (answer: ScribeAnswer) => void;
}): JSX.Element {
  const [raw, setRaw] = useState(existing?.raw ?? '');
  const [interim, setInterim] = useState('');
  const [answer, setAnswer] = useState<ScribeAnswer | undefined>(existing);
  const [editing, setEditing] = useState(existing?.accepted ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const dictation = useRef<Dictation | null>(null);
  const speech = useMemo(() => isSpeechAvailable(), []);

  useEffect(() => {
    setRaw(existing?.raw ?? '');
    setAnswer(existing);
    setEditing(existing?.accepted ?? '');
    setError(null);
    setInterim('');
  }, [existing, prompt.id]);

  useEffect(() => () => dictation.current?.stop(), []);

  const toggleMic = () => {
    if (listening) {
      dictation.current?.stop();
      dictation.current = null;
      setListening(false);
      setInterim('');
      return;
    }
    const base = raw ? `${raw.trim()} ` : '';
    const session = startDictation({
      onTranscript: (final, partial) => {
        setRaw(base + final);
        setInterim(partial);
      },
      onError: (message, fatal) => {
        setError(message);
        if (fatal) {
          setListening(false);
          setInterim('');
        }
      },
      onEnd: () => {
        setListening(false);
        setInterim('');
      },
    });
    if (!session) {
      setError('Dictation is not available in this browser. Type your answer instead.');
      return;
    }
    dictation.current = session;
    setListening(true);
  };

  /** Saves the raw capture first, so nothing spoken can be lost. */
  const capture = async (): Promise<ScribeAnswer> => {
    const captured: ScribeAnswer = {
      questionId: prompt.id,
      prompt: prompt.text,
      raw: existing?.raw || raw,
      capturedAt: existing?.capturedAt ?? Date.now(),
      source: listening || existing?.source === 'voice' ? 'voice' : 'typed',
      ...(answer ?? {}),
      ...(existing?.raw ? {} : { raw }),
    };
    setAnswer(captured);
    onSaved(captured);
    return captured;
  };

  const clean = async () => {
    setBusy(true);
    setError(null);
    try {
      const captured = await capture();
      const result = await cleanupAnswer(captured);
      setAnswer(result.answer);
      setEditing(result.answer.cleaned ?? result.answer.raw);
      if (result.error)
        setError(`Cleanup failed: ${result.error}. Your words are still here, untouched.`);
      onSaved(result.answer);
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    const captured = await capture();
    const accepted = (editing || captured.cleaned || captured.raw).trim();
    const next: ScribeAnswer = { ...captured, accepted, acceptedAt: Date.now() };
    setAnswer(next);
    onSaved(next);
  };

  const added = answer?.diff?.addedWords ?? [];

  return (
    <div className="card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>
          Question {index + 1} of {total}
        </h2>
        {answer?.acceptedAt && <Pill kind="ok">Accepted</Pill>}
      </div>
      <p style={{ fontSize: 16, margin: '10px 0 16px' }}>{prompt.text}</p>

      {error && <Banner kind="warn">{error}</Banner>}

      <label className="field">
        <span>Your answer — speak it or type it</span>
        <textarea
          rows={6}
          value={raw + (interim ? ` ${interim}` : '')}
          placeholder="Say it however it comes out. Filler and false starts are fine — they get cleaned up."
          onChange={(e) => setRaw(e.target.value)}
        />
      </label>

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button
          className={`btn ${listening ? 'danger' : ''}`}
          onClick={toggleMic}
          disabled={!speech}
        >
          {listening ? 'Stop dictation' : 'Start dictation'}
        </button>
        <button className="btn" onClick={clean} disabled={busy || !raw.trim()}>
          {busy ? 'Cleaning…' : 'Clean up'}
        </button>
        <button className="btn primary" onClick={accept} disabled={!raw.trim()}>
          Accept answer
        </button>
      </div>
      {!speech && (
        <p className="sub" style={{ marginTop: 8 }}>
          Dictation is not available in this browser, so typing is the only input here. Everything
          else works normally.
        </p>
      )}

      {answer?.cleaned && (
        <>
          <h3 style={{ marginTop: 22, marginBottom: 4 }}>What changed</h3>
          {answer.diff?.clean ? (
            <Banner kind="ok">
              No words were added. Only filler, repetition, spelling and punctuation changed
              {answer.diff.removedFiller.length > 0 && (
                <> — removed: {answer.diff.removedFiller.join(', ')}</>
              )}
              .
            </Banner>
          ) : (
            <Banner kind="danger">
              <strong>
                {added.length} word{added.length === 1 ? '' : 's'} added that you did not say:
              </strong>{' '}
              {added.join(', ')}. Delete them before you accept, or use your raw text instead.
            </Banner>
          )}

          <div className="row" style={{ gap: 16, alignItems: 'flex-start', marginTop: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h4 style={{ margin: '0 0 6px' }}>What you said</h4>
              <p className="sub" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                {answer.raw}
              </p>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h4 style={{ margin: '0 0 6px' }}>Cleaned, word by word</h4>
              <DiffView diff={answer.diff!} />
            </div>
          </div>

          <label className="field" style={{ marginTop: 12 }}>
            <span>Final answer — edit freely, this is what gets exported</span>
            <textarea rows={6} value={editing} onChange={(e) => setEditing(e.target.value)} />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary" onClick={accept}>
              Accept this version
            </button>
            <button className="btn" onClick={() => setEditing(answer.raw)}>
              Use my raw words instead
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Scribe mode.
 *
 * Sid answers one question at a time, by voice or by typing. The raw capture is
 * stored before any cleanup and is never overwritten. Cleanup is optional per
 * answer, and its output is only ever a suggestion he accepts or edits.
 */
export function Scribe({ item, onClose }: { item: WorkItem; onClose: () => void }): JSX.Element {
  const [session, setSession] = useState<ScribeSession | null>(null);
  const [current, setCurrent] = useState(0);
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      const existing = await loadSession(item.id);
      setSession(existing ?? (await startSession(item)));
    })();
  }, [item]);

  const onSaved = async (answer: ScribeAnswer) => {
    const next = await saveAnswer(item.id, answer);
    setSession(next);
  };

  if (!session) return <p className="sub">Loading…</p>;

  if (session.prompts.length === 0) {
    return (
      <div className="card">
        <h2>Scribe mode — {item.title}</h2>
        <Banner kind="info">
          This assignment has no description to read the questions from, so paste them in. One
          question per line.
        </Banner>
        <label className="field">
          <span>Questions</span>
          <textarea
            rows={8}
            value={paste}
            placeholder={'1. Why did the policy fail?\n2. Who benefited most?'}
            onChange={(e) => setPaste(e.target.value)}
          />
        </label>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button
            className="btn primary"
            disabled={promptsFromPaste(paste).length === 0}
            onClick={async () => setSession(await startSession(item, paste))}
          >
            Use these {promptsFromPaste(paste).length || ''} questions
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const answered = session.answers.filter((a) => a.acceptedAt).length;
  const prompt = session.prompts[current];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scribe mode</h1>
          <p className="sub">
            {item.title} — {answered} of {session.prompts.length} accepted.
            {session.promptSource === 'pasted' && ' Questions pasted by you.'}
          </p>
        </div>
        <button className="btn" onClick={onClose}>
          Back to assignment
        </button>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {session.prompts.map((p, index) => {
            const answer = session.answers.find((a) => a.questionId === p.id);
            return (
              <button
                key={p.id}
                className={`btn small ${index === current ? 'primary' : ''}`}
                onClick={() => setCurrent(index)}
                title={p.text}
              >
                {index + 1}
                {answer?.acceptedAt ? ' ✓' : answer?.raw ? ' •' : ''}
              </button>
            );
          })}
        </div>
      </div>

      <AnswerEditor
        key={prompt.id}
        prompt={prompt}
        index={current}
        total={session.prompts.length}
        existing={session.answers.find((a) => a.questionId === prompt.id)}
        onSaved={onSaved}
      />

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}>
          Previous
        </button>
        <button
          className="btn"
          disabled={current >= session.prompts.length - 1}
          onClick={() => setCurrent((c) => c + 1)}
        >
          Next question
        </button>
      </div>

      <div className="card">
        <h2>Export</h2>
        <p className="sub">Accepted answers only, in question order.</p>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn"
            disabled={answered === 0}
            onClick={async () => {
              await navigator.clipboard.writeText(exportAsText(session));
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? 'Copied' : 'Copy all answers'}
          </button>
          <button
            className="btn"
            disabled={answered === 0}
            onClick={() => {
              const blob = new Blob([exportAsText(session)], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = `${item.title.replace(/[^\w -]/g, '')} - answers.txt`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download as text
          </button>
        </div>
        <p className="sub" style={{ marginTop: 10 }}>
          To put these in a Google Doc, copy them, paste into your doc, then use the Google Docs
          formatter to apply the assignment formatting.
        </p>
      </div>
    </>
  );
}
