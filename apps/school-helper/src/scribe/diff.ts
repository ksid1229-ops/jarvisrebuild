/**
 * Word-level diff between what Sid actually said and what cleanup produced.
 *
 * This is the proof in "proof, not trust". Scribe mode is an accommodation, not
 * a writing aid: cleanup may remove disfluency and fix mechanics, but it may
 * not contribute meaning. This module decides, mechanically, whether it did.
 *
 * What counts as an added word:
 *   - filler removed ........................ not an addition (it's a removal)
 *   - punctuation and capitalisation ........ never counts
 *   - a spelling fix of a word he did say ... never counts
 *   - an expanded or contracted form ........ never counts ("don't" / "do not")
 *   - anything else ......................... COUNTS, and is listed by name
 *
 * If `clean` is false, the UI must show every added word before Sid can accept.
 */

import type { ScribeDiff, ScribeDiffToken } from '../common/types';

/**
 * Disfluency and verbal padding. Removing these is the point of scribe mode.
 * Only ever used to explain a removal or to forgive an addition of the same
 * word — never to let a content word through.
 */
export const FILLER = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'er',
  'erm',
  'ah',
  'ahh',
  'eh',
  'hmm',
  'mm',
  'mhm',
  'like',
  'basically',
  'literally',
  'actually',
  'honestly',
  'obviously',
  'anyway',
  'anyways',
  'whatever',
  'okay',
  'ok',
  'so',
  'well',
  'right',
  'yeah',
  'yep',
  'kinda',
  'sorta',
  'gonna',
  'wanna',
]);

/** Multi-word fillers, matched on the normalized token stream. */
export const FILLER_PHRASES = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
  ['a', 'bit'],
  ['or', 'something'],
  ['and', 'stuff'],
  ['and', 'things'],
];

/** Contractions cleanup may legitimately expand or contract. */
const CONTRACTIONS: Record<string, string> = {
  "don't": 'do not',
  "doesn't": 'does not',
  "didn't": 'did not',
  "can't": 'can not',
  cannot: 'can not',
  "won't": 'will not',
  "wouldn't": 'would not',
  "shouldn't": 'should not',
  "couldn't": 'could not',
  "isn't": 'is not',
  "aren't": 'are not',
  "wasn't": 'was not',
  "weren't": 'were not',
  "it's": 'it is',
  "that's": 'that is',
  "there's": 'there is',
  "they're": 'they are',
  "we're": 'we are',
  "i'm": 'i am',
  "i've": 'i have',
  "you've": 'you have',
  "we've": 'we have',
  "they've": 'they have',
  "i'd": 'i would',
  "i'll": 'i will',
};

export interface Token {
  text: string;
  /** Lowercased, punctuation-stripped form used for matching. */
  norm: string;
  isWord: boolean;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’\u2019-][\p{L}\p{N}]+)*/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  for (const match of text.matchAll(WORD_RE)) {
    const start = match.index ?? 0;
    if (start > index) {
      const gap = text.slice(index, start);
      const trimmed = gap.trim();
      if (trimmed) tokens.push({ text: trimmed, norm: trimmed, isWord: false });
    }
    const word = match[0];
    tokens.push({ text: word, norm: normalizeWord(word), isWord: true });
    index = start + word.length;
  }
  const tail = text.slice(index).trim();
  if (tail) tokens.push({ text: tail, norm: tail, isWord: false });
  return tokens;
}

export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’\u2019]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
}

/** Levenshtein, capped — we only care about "close enough to be a typo fix". */
export function editDistance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * True when `added` is plausibly a corrected spelling of something removed
 * nearby, rather than a new word. Short words need an exact-ish match so that
 * "not" is never forgiven as a typo of "now".
 */
function isSpellingFixOf(added: string, removed: string[]): boolean {
  if (!added) return false;
  for (const candidate of removed) {
    if (!candidate) continue;
    if (candidate === added) return true;
    const longest = Math.max(candidate.length, added.length);
    if (longest <= 3) {
      // Too short for fuzzy matching, but a pure transposition ("teh" -> "the")
      // is still obviously a typo fix rather than a new word.
      if (
        candidate.length === added.length &&
        [...candidate].sort().join('') === [...added].sort().join('')
      )
        return true;
      continue;
    }
    const allowed = longest <= 5 ? 1 : 2;
    if (editDistance(candidate, added, allowed) <= allowed) return true;
    // Simple inflection: "argue" / "argues" / "argued" / "arguing"
    const stem = (w: string) => w.replace(/(ing|ed|es|s)$/u, '');
    if (stem(candidate).length > 3 && stem(candidate) === stem(added)) return true;
  }
  return false;
}

/** Expands contractions so "don't" and "do not" compare equal. */
function expand(tokens: Token[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (!token.isWord) continue;
    const expansion = CONTRACTIONS[token.norm];
    if (expansion) out.push(...expansion.split(' '));
    else out.push(token.norm);
  }
  return out;
}

interface Op {
  kind: 'same' | 'added' | 'removed';
  index: number;
}

/** Classic LCS backtrack over normalized word streams. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', index: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: 'removed', index: i });
      i += 1;
    } else {
      ops.push({ kind: 'added', index: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'removed', index: i });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'added', index: j });
    j += 1;
  }
  return ops;
}

function stripFillerPhrases(words: string[]): Set<number> {
  const inPhrase = new Set<number>();
  for (let i = 0; i < words.length; i += 1) {
    for (const phrase of FILLER_PHRASES) {
      if (phrase.every((word, k) => words[i + k] === word)) {
        for (let k = 0; k < phrase.length; k += 1) inPhrase.add(i + k);
      }
    }
  }
  return inPhrase;
}

/**
 * Compares raw speech against cleaned text.
 *
 * Returns the token stream for rendering, every meaningful added word, and the
 * filler that was removed. `clean` is true only when nothing meaningful was
 * added — that is the condition the UI uses to say "no words were added".
 */
export function diffAnswer(raw: string, cleaned: string): ScribeDiff {
  const rawWords = expand(tokenize(raw));
  const cleanTokens = tokenize(cleaned).filter((t) => t.isWord);
  const cleanWords = expand(tokenize(cleaned));

  const ops = lcsOps(rawWords, cleanWords);
  const removedWords = ops.filter((o) => o.kind === 'removed').map((o) => rawWords[o.index]);
  const rawFillerPhrase = stripFillerPhrases(rawWords);

  const addedWords: string[] = [];
  const removedFiller: string[] = [];
  const tokens: ScribeDiffToken[] = [];

  // Map expanded-word positions back to display tokens where possible.
  let cleanCursor = 0;
  for (const op of ops) {
    if (op.kind === 'removed') {
      const word = rawWords[op.index];
      const filler = FILLER.has(word) || rawFillerPhrase.has(op.index);
      if (filler) removedFiller.push(word);
      tokens.push({ text: word, kind: 'removed', meaningful: !filler });
      continue;
    }
    const word = cleanWords[op.index];
    const display = cleanTokens[cleanCursor]?.text ?? word;
    if (op.kind === 'same') {
      tokens.push({ text: display, kind: 'same', meaningful: false });
      cleanCursor += 1;
      continue;
    }
    // Added.
    const forgiven = FILLER.has(word) || isSpellingFixOf(word, removedWords);
    if (!forgiven) addedWords.push(word);
    tokens.push({ text: display, kind: 'added', meaningful: !forgiven });
    cleanCursor += 1;
  }

  return { tokens, addedWords, removedFiller, clean: addedWords.length === 0 };
}
