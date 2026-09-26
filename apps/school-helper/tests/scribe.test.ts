import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/common/db';
import type { CompletionResult } from '../src/ai/provider';
import type { ScribeAnswer, WorkItem } from '../src/common/types';
import { diffAnswer, editDistance, tokenize } from '../src/scribe/diff';
import { CLEANUP_SYSTEM_PROMPT, cleanupAnswer } from '../src/scribe/cleanup';
import { isSpeechAvailable, startDictation } from '../src/scribe/speech';
import {
  exportAsText,
  extractPrompts,
  loadSession,
  promptsFromPaste,
  saveAnswer,
  startSession,
} from '../src/scribe/session';

const reply = (text: string): CompletionResult => ({
  text,
  promptTokens: 1,
  completionTokens: 1,
  estimatedCostUsd: 0,
  providerLabel: 'fake',
  model: 'fake',
});

const answer = (raw: string, overrides: Partial<ScribeAnswer> = {}): ScribeAnswer => ({
  questionId: 'q1',
  prompt: 'Why did the policy fail?',
  raw,
  capturedAt: 1,
  source: 'voice',
  ...overrides,
});

beforeEach(async () => {
  await db.scribeSessions.clear();
});

describe('the word-level diff — the proof that nothing was added', () => {
  it('FLAGS AN INSERTED WORD and names it', () => {
    const diff = diffAnswer('the tariff raised prices', 'The tariff dramatically raised prices.');
    expect(diff.clean).toBe(false);
    expect(diff.addedWords).toEqual(['dramatically']);
    expect(
      diff.tokens.some(
        (t) => t.kind === 'added' && t.meaningful && t.text.toLowerCase() === 'dramatically',
      ),
    ).toBe(true);
  });

  it('IGNORES FILLER REMOVAL — that is the whole point of cleanup', () => {
    const diff = diffAnswer(
      'um so like the tariff uh raised prices you know',
      'The tariff raised prices.',
    );
    expect(diff.clean).toBe(true);
    expect(diff.addedWords).toEqual([]);
    expect(diff.removedFiller).toEqual(expect.arrayContaining(['um', 'so', 'like', 'uh']));
  });

  it('ignores punctuation and capitalisation', () => {
    const diff = diffAnswer(
      'the tariff raised prices it hurt exports',
      'The tariff raised prices. It hurt exports!',
    );
    expect(diff.clean).toBe(true);
    expect(diff.addedWords).toEqual([]);
  });

  it('ignores a spelling fix of a word he did say', () => {
    const diff = diffAnswer(
      'the goverment recieved teh money',
      'The government received the money.',
    );
    expect(diff.clean).toBe(true);
    expect(diff.addedWords).toEqual([]);
  });

  it('ignores contraction expansion in either direction', () => {
    expect(diffAnswer("it doesn't work", 'It does not work.').clean).toBe(true);
    expect(diffAnswer('it does not work', "It doesn't work.").clean).toBe(true);
  });

  it('ignores repeated-word and false-start removal', () => {
    const diff = diffAnswer('the the tariff raised raised prices', 'The tariff raised prices.');
    expect(diff.clean).toBe(true);
  });

  it('CATCHES A SMUGGLED TRANSITION', () => {
    const diff = diffAnswer(
      'prices went up exports fell',
      'Prices went up. Consequently, exports fell.',
    );
    expect(diff.clean).toBe(false);
    expect(diff.addedWords).toContain('consequently');
  });

  it('CATCHES AN INVENTED FACT', () => {
    const diff = diffAnswer(
      'the tariff raised prices',
      'The 1930 Smoot-Hawley tariff raised prices.',
    );
    expect(diff.clean).toBe(false);
    expect(diff.addedWords).toEqual(expect.arrayContaining(['1930', 'smoot-hawley']));
  });

  it('CATCHES A NEGATION FLIP rather than forgiving it as a typo', () => {
    const diff = diffAnswer('the policy worked', 'The policy never worked.');
    expect(diff.clean).toBe(false);
    expect(diff.addedWords).toContain('never');
  });

  it('does not forgive a short content word as a spelling fix', () => {
    // "now" must not be waved through as a typo of "not".
    const diff = diffAnswer('it is not fair', 'It is not now fair.');
    expect(diff.clean).toBe(false);
    expect(diff.addedWords).toContain('now');
  });

  it('is clean when the text is unchanged', () => {
    expect(diffAnswer('the tariff raised prices', 'the tariff raised prices').clean).toBe(true);
  });

  it('reports every added word, not just the first', () => {
    const diff = diffAnswer('prices rose', 'Prices rose sharply and unemployment followed.');
    expect(diff.addedWords).toEqual(
      expect.arrayContaining(['sharply', 'unemployment', 'followed']),
    );
  });

  it('tokenizes hyphenated and apostrophed words as single words', () => {
    const words = tokenize("Smoot-Hawley didn't work").filter((t) => t.isWord);
    expect(words.map((w) => w.text)).toEqual(['Smoot-Hawley', "didn't", 'work']);
  });

  it('edit distance is bounded and symmetric enough for typo detection', () => {
    expect(editDistance('government', 'goverment')).toBe(1);
    expect(editDistance('cat', 'elephant', 3)).toBeGreaterThan(3);
  });
});

describe('cleanup', () => {
  it('PRESERVES THE RAW ANSWER WHEN CLEANUP FAILS', async () => {
    const result = await cleanupAnswer(answer('um the tariff raised prices'), {
      completeImpl: async () => {
        throw new Error('provider exploded');
      },
    });
    expect(result.answer.raw).toBe('um the tariff raised prices');
    expect(result.answer.cleaned).toBeUndefined();
    expect(result.error).toBe('provider exploded');
  });

  it('preserves the raw answer when the provider returns nothing', async () => {
    const result = await cleanupAnswer(answer('the tariff raised prices'), {
      completeImpl: async () => reply('   '),
    });
    expect(result.answer.raw).toBe('the tariff raised prices');
    expect(result.error).toBe('empty-response');
  });

  it('never overwrites raw with the cleaned text', async () => {
    const result = await cleanupAnswer(answer('um the tariff raised prices'), {
      completeImpl: async () => reply('The tariff raised prices.'),
    });
    expect(result.answer.raw).toBe('um the tariff raised prices');
    expect(result.answer.cleaned).toBe('The tariff raised prices.');
    expect(result.clean).toBe(true);
  });

  it('reports a model that added content instead of silently accepting it', async () => {
    const result = await cleanupAnswer(answer('the tariff raised prices'), {
      completeImpl: async () =>
        reply('The protectionist tariff raised consumer prices significantly.'),
    });
    expect(result.clean).toBe(false);
    expect(result.answer.diff?.addedWords.length).toBeGreaterThan(0);
  });

  it('the prompt forbids adding ideas, facts and transitions', () => {
    for (const rule of ['add an idea, fact, example', 'transition', 'LEAVE IT VAGUE', 'may not']) {
      expect(CLEANUP_SYSTEM_PROMPT.toLowerCase()).toContain(rule.toLowerCase());
    }
  });

  it('does not call the provider for an empty answer', async () => {
    let called = false;
    const result = await cleanupAnswer(answer('   '), {
      completeImpl: async () => {
        called = true;
        return reply('x');
      },
    });
    expect(called).toBe(false);
    expect(result.error).toBe('nothing-to-clean');
  });
});

describe('voice, with the typing fallback always available', () => {
  it('TYPING FALLBACK: reports unavailable when the API is missing', () => {
    const scope = {} as typeof globalThis;
    expect(isSpeechAvailable(scope)).toBe(false);
    expect(startDictation({ onTranscript: () => {}, onError: () => {} }, scope)).toBeNull();
  });

  it('reports available and streams final plus interim text when present', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const scope = {
      webkitSpeechRecognition: class {
        lang = '';
        continuous = false;
        interimResults = false;
        maxAlternatives = 0;
        set onresult(fn: (e: unknown) => void) {
          handlers.result = fn;
        }
        set onerror(fn: (e: unknown) => void) {
          handlers.error = fn;
        }
        set onend(fn: (e: unknown) => void) {
          handlers.end = fn;
        }
        start() {}
        stop() {}
        abort() {}
      },
    } as unknown as typeof globalThis;

    expect(isSpeechAvailable(scope)).toBe(true);
    const seen: [string, string][] = [];
    const dictation = startDictation(
      { onTranscript: (f, i) => seen.push([f, i]), onError: () => {} },
      scope,
    );
    expect(dictation).not.toBeNull();

    // The real API hands back a cumulative results list with a moving resultIndex.
    const first = { isFinal: true, 0: { transcript: 'the tariff' } };
    const second = { isFinal: false, 0: { transcript: ' raised prices' } };
    handlers.result({ resultIndex: 0, results: [first] });
    handlers.result({ resultIndex: 1, results: [first, second] });
    expect(seen[0]).toEqual(['the tariff', '']);
    expect(seen[1][1]).toBe('raised prices');
  });

  it('a refused microphone is a fatal, explained error — not a crash', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const scope = {
      webkitSpeechRecognition: class {
        lang = '';
        continuous = false;
        interimResults = false;
        maxAlternatives = 0;
        set onresult(fn: (e: unknown) => void) {
          handlers.result = fn;
        }
        set onerror(fn: (e: unknown) => void) {
          handlers.error = fn;
        }
        set onend(fn: (e: unknown) => void) {
          handlers.end = fn;
        }
        start() {}
        stop() {}
        abort() {}
      },
    } as unknown as typeof globalThis;

    const errors: [string, boolean][] = [];
    startDictation(
      { onTranscript: () => {}, onError: (m, fatal) => errors.push([m, fatal]) },
      scope,
    );
    handlers.error({ error: 'not-allowed' });
    expect(errors[0][1]).toBe(true);
    expect(errors[0][0]).toMatch(/Type your answer instead/);
  });
});

describe('sessions', () => {
  const item = {
    id: 'ldsb:1001:dropbox:55',
    courseId: 'ldsb:1001',
    board: 'ldsb',
    kind: 'assignment',
    remoteId: '55',
    title: 'Unit 3 Response',
    status: 'unsubmitted',
    firstSeenAt: 1,
    lastSeenAt: 1,
    presentInLastSync: true,
  } as unknown as WorkItem;

  it('extracts numbered questions from a description', () => {
    const prompts = extractPrompts(
      '<p>Answer all three.</p><ol><li>Why did the policy fail?</li><li>Who benefited from it most?</li><li>What would you change and why?</li></ol>',
    );
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toBe('Why did the policy fail?');
  });

  it('falls back to question marks, then to instruction verbs', () => {
    expect(
      extractPrompts('<p>Explain why the tariff failed in your own words and give reasons.</p>'),
    ).toHaveLength(1);
    expect(extractPrompts('<p>Some blurb about nothing.</p>')).toEqual([]);
  });

  it('asks for a paste rather than inventing prompts when the description is empty', async () => {
    const session = await startSession({ ...item, description: '' });
    expect(session.prompts).toEqual([]);
    expect(session.promptSource).toBe('description');
  });

  it('accepts pasted prompts and strips the numbering', () => {
    expect(promptsFromPaste('1. First question here\n2) Second question here')).toEqual([
      'First question here',
      'Second question here',
    ]);
  });

  it('THE RAW CAPTURE SURVIVES A LATER EDIT', async () => {
    await startSession({
      ...item,
      description: '<ol><li>Why did the policy fail?</li><li>Who benefited?</li></ol>',
    });
    await saveAnswer(item.id, answer('um the tariff raised prices'));
    await saveAnswer(
      item.id,
      answer('COMPLETELY DIFFERENT', { accepted: 'The tariff raised prices.' }),
    );

    const session = await loadSession(item.id);
    expect(session!.answers[0].raw).toBe('um the tariff raised prices');
    expect(session!.answers[0].accepted).toBe('The tariff raised prices.');
  });

  it('exports accepted answers in question order', async () => {
    await startSession({
      ...item,
      description: '<ol><li>Why did the policy fail?</li><li>Who benefited?</li></ol>',
    });
    await saveAnswer(
      item.id,
      answer('second answer', { questionId: 'q2', accepted: 'Exporters did.' }),
    );
    await saveAnswer(
      item.id,
      answer('first answer', { questionId: 'q1', accepted: 'Because prices rose.' }),
    );

    const session = await loadSession(item.id);
    const text = exportAsText(session!);
    expect(text.indexOf('Because prices rose.')).toBeLessThan(text.indexOf('Exporters did.'));
    expect(text).toContain('1. Why did the policy fail?');
  });

  it('skips unanswered questions on export', async () => {
    await startSession({
      ...item,
      description: '<ol><li>Why did the policy fail?</li><li>Who benefited?</li></ol>',
    });
    await saveAnswer(
      item.id,
      answer('first', { questionId: 'q1', accepted: 'Because prices rose.' }),
    );
    const session = await loadSession(item.id);
    expect(exportAsText(session!)).not.toContain('Who benefited?');
  });
});
