import { AiError, registerAdapter, type Adapter, type CompletionRequest } from './provider';
import type { AiProviderConfig } from '../common/types';

/**
 * Anthropic Messages API adapter.
 * Differences from the OpenAI shape: the system prompt is a top-level field,
 * auth uses x-api-key, and a version header is required.
 */
export const anthropicAdapter: Adapter = {
  kind: 'anthropic',
  async complete(cfg: AiProviderConfig, apiKey: string, req: CompletionRequest) {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/messages`;

    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: req.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // Required for calls originating in a browser extension context.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: cfg.model,
          system: system || undefined,
          messages: messages.length ? messages : [{ role: 'user', content: '' }],
          max_tokens: req.maxTokens ?? cfg.maxOutputTokens ?? 2048,
          temperature: req.temperature ?? 0.2,
        }),
      });
    } catch (err) {
      throw new AiError(`Could not reach ${cfg.baseUrl}: ${(err as Error).message}`, 'network');
    }

    const raw = await res.text();
    if (!res.ok)
      throw new AiError(`${cfg.model} returned ${res.status}: ${shorten(raw)}`, 'provider');

    let json: AnthropicResponse;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new AiError(`Unexpected response from ${cfg.baseUrl}: ${shorten(raw)}`, 'provider');
    }

    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!text) throw new AiError('The model returned an empty response.', 'provider');

    return {
      text,
      promptTokens: json.usage?.input_tokens ?? 0,
      completionTokens: json.usage?.output_tokens ?? 0,
    };
  },
};

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function shorten(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

registerAdapter(anthropicAdapter);
