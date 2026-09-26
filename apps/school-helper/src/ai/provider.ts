import { db, getSettings } from '../common/db';
import { decryptSecret, scrubSecrets } from '../common/crypto';
import { isLocalEndpoint } from '../common/settings';
import type { AiCallRecord, AiProviderConfig, AiRole } from '../common/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  role: AiRole;
  feature: AiCallRecord['feature'];
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Set when the user has already seen and accepted the disclosure. */
  disclosureAccepted?: boolean;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  providerLabel: string;
  model: string;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'policy' | 'network' | 'provider' | 'budget',
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface Disclosure {
  providerLabel: string;
  host: string;
  model: string;
  isLocal: boolean;
  approxPromptTokens: number;
  estimatedCostUsd: number;
  /** What is actually being sent, so it can be shown verbatim. */
  preview: string;
}

/** Rough token estimate: ~4 characters per token for English prose. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCost(
  cfg: AiProviderConfig,
  promptTokens: number,
  completionTokens: number,
): number {
  const inRate = cfg.inputCostPerMTok ?? 0;
  const outRate = cfg.outputCostPerMTok ?? 0;
  return (promptTokens / 1e6) * inRate + (completionTokens / 1e6) * outRate;
}

/** Build the "this is where your data is going" notice shown before every call. */
export async function describeCall(req: CompletionRequest): Promise<Disclosure> {
  const settings = await getSettings();
  const cfg = settings.providers[req.role];
  const joined = req.messages.map((m) => m.content).join('\n');
  const promptTokens = estimateTokens(joined);
  let host = cfg.baseUrl;
  try {
    host = new URL(cfg.baseUrl).host;
  } catch {}
  return {
    providerLabel: cfg.label,
    host,
    model: cfg.model,
    isLocal: cfg.isLocal || isLocalEndpoint(cfg.baseUrl),
    approxPromptTokens: promptTokens,
    estimatedCostUsd: estimateCost(cfg, promptTokens, cfg.maxOutputTokens ?? 1024),
    preview:
      joined.length > 4000
        ? `${joined.slice(0, 4000)}\n… (${joined.length - 4000} more characters)`
        : joined,
  };
}

export interface Adapter {
  kind: AiProviderConfig['kind'];
  complete(
    cfg: AiProviderConfig,
    apiKey: string,
    req: CompletionRequest,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }>;
}

const adapters = new Map<string, Adapter>();
export function registerAdapter(a: Adapter): void {
  adapters.set(a.kind, a);
}

/** Month key for the running cost total. */
export function monthKey(at = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function monthlySpend(
  at = Date.now(),
): Promise<{ usd: number; calls: number; tokens: number }> {
  const key = monthKey(at);
  const all = await db.aiCalls.toArray();
  const mine = all.filter((c) => monthKey(c.at) === key);
  return {
    usd: mine.reduce((s, c) => s + c.estimatedCostUsd, 0),
    calls: mine.length,
    tokens: mine.reduce((s, c) => s + c.promptTokens + c.completionTokens, 0),
  };
}

/**
 * Run a completion.
 *
 * Enforced before anything leaves the machine:
 *  - "local model only" blocks non-local endpoints outright
 *  - the monthly budget blocks calls that would exceed it
 *  - the disclosure must have been accepted when that setting is on
 */
export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const settings = await getSettings();
  const cfg = settings.providers[req.role];

  if (!cfg.baseUrl || !cfg.model) {
    throw new AiError(
      `No ${req.role} model configured. Add a base URL and model name in Settings.`,
      'config',
    );
  }

  const local = cfg.isLocal || isLocalEndpoint(cfg.baseUrl);
  if (settings.localModelOnly && !local) {
    throw new AiError(
      `"Local model only" is on, and ${cfg.baseUrl} is not a local endpoint. Nothing was sent.`,
      'policy',
    );
  }
  if (settings.confirmBeforeAiCall && !req.disclosureAccepted) {
    throw new AiError(
      'This call needs your confirmation first (Settings → confirm before AI calls).',
      'policy',
    );
  }

  const promptText = req.messages.map((m) => m.content).join('\n');
  const promptTokensEst = estimateTokens(promptText);

  if (settings.monthlyBudgetUsd != null && !local) {
    const spent = await monthlySpend();
    const projected =
      spent.usd + estimateCost(cfg, promptTokensEst, req.maxTokens ?? cfg.maxOutputTokens ?? 1024);
    if (projected > settings.monthlyBudgetUsd) {
      throw new AiError(
        `This call would push this month past your $${settings.monthlyBudgetUsd} budget (spent $${spent.usd.toFixed(3)}). Raise it in Settings or switch to a local model.`,
        'budget',
      );
    }
  }

  const adapter = adapters.get(cfg.kind);
  if (!adapter) throw new AiError(`No adapter for provider kind "${cfg.kind}".`, 'config');

  const apiKey = await decryptSecret(cfg.apiKeyCipher);
  if (!apiKey && !local) {
    throw new AiError(`No API key saved for the ${req.role} model. Add one in Settings.`, 'config');
  }

  const record: AiCallRecord = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    role: req.role,
    providerLabel: cfg.label,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    feature: req.feature,
    promptTokens: promptTokensEst,
    completionTokens: 0,
    estimatedCostUsd: 0,
    ok: false,
  };

  try {
    const out = await adapter.complete(cfg, apiKey, req);
    record.promptTokens = out.promptTokens || promptTokensEst;
    record.completionTokens = out.completionTokens || estimateTokens(out.text);
    record.estimatedCostUsd = estimateCost(cfg, record.promptTokens, record.completionTokens);
    record.ok = true;
    await db.aiCalls.put(record);
    return {
      text: out.text,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      estimatedCostUsd: record.estimatedCostUsd,
      providerLabel: cfg.label,
      model: cfg.model,
    };
  } catch (err) {
    // scrubSecrets guarantees a leaked key never lands in the call log.
    record.error = scrubSecrets((err as Error).message, [apiKey]).slice(0, 500);
    await db.aiCalls.put(record);
    throw err instanceof AiError ? err : new AiError(record.error, 'provider');
  }
}
