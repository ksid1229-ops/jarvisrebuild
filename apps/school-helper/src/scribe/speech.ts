/**
 * Voice capture for scribe mode, with a typing fallback that is always present.
 *
 * Web Speech API only. Nothing is uploaded by this module: recognition runs in
 * the browser. If the API is missing, blocked, or the microphone is refused,
 * `isSpeechAvailable()` returns false and the UI shows the textarea alone —
 * typing is never gated behind voice working.
 */

export const SPEECH_LANG = 'en-CA';

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function ctor(scope: typeof globalThis = globalThis): RecognitionCtor | undefined {
  const win = scope as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return win.webkitSpeechRecognition ?? win.SpeechRecognition;
}

export function isSpeechAvailable(scope: typeof globalThis = globalThis): boolean {
  return typeof ctor(scope) === 'function';
}

export interface DictationHandlers {
  /** Fires with the stable text so far, plus whatever is still being spoken. */
  onTranscript: (final: string, interim: string) => void;
  onError: (message: string, fatal: boolean) => void;
  onEnd?: () => void;
}

export interface Dictation {
  stop(): void;
  readonly active: boolean;
}

const MESSAGES: Record<string, string> = {
  'not-allowed':
    'Microphone access was refused. Type your answer instead, or allow the microphone and try again.',
  'service-not-allowed': 'The browser blocked speech recognition. Type your answer instead.',
  'audio-capture': 'No microphone was found. Type your answer instead.',
  network: 'Speech recognition needs a network connection. Type your answer instead.',
  'no-speech': 'Nothing was heard. Try again, or type your answer.',
  aborted: 'Dictation stopped.',
};

/**
 * Starts dictation. Returns null when speech is unavailable, which the caller
 * must treat as "show the textarea" rather than as an error state.
 */
export function startDictation(
  handlers: DictationHandlers,
  scope: typeof globalThis = globalThis,
): Dictation | null {
  const Recognition = ctor(scope);
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.lang = SPEECH_LANG;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let active = true;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const chunk = result[0].transcript;
      if (result.isFinal)
        finalText += (finalText && !finalText.endsWith(' ') ? ' ' : '') + chunk.trim();
      else interim += chunk;
    }
    handlers.onTranscript(finalText, interim.trim());
  };

  recognition.onerror = (event) => {
    // 'no-speech' and 'aborted' are recoverable; the rest end the session.
    const fatal = !['no-speech', 'aborted'].includes(event.error);
    handlers.onError(MESSAGES[event.error] ?? `Dictation error: ${event.error}`, fatal);
    if (fatal) active = false;
  };

  recognition.onend = () => {
    active = false;
    handlers.onEnd?.();
  };

  try {
    recognition.start();
  } catch (error) {
    handlers.onError(`Dictation could not start: ${(error as Error).message}`, true);
    return null;
  }

  return {
    stop() {
      active = false;
      try {
        recognition.stop();
      } catch {
        recognition.abort();
      }
    },
    get active() {
      return active;
    },
  };
}
