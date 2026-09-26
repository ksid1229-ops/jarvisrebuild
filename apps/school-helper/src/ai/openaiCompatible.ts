import { AiError, registerAdapter, type Adapter, type CompletionRequest } from './provider';
import type { AiProviderConfig } from '../common/types';

/**
 * OpenAI-compatible /chat/completions adapter.
 * Covers OpenAI, DeepSeek, OpenRouter, Together, Groq, Ollama (/v1) and
 * LM Studio, which all speak the same wire format.
 */
export const openAiCompatibleAdapter: Adapter = {
  kind: 'openai-compatible',
  async complete(cfg: AiProviderConfig, apiKey: string, req: CompletionRequest) {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // OpenRouter asks for these; harmless elsewhere.
    headers['HTTP-Referer'] = 'https://localhost/school-helper';
    headers['X-Title'] = 'School Helper';

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        signal: req.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? cfg.maxOutputTokens ?? 2048,
          stream: false,
        }),
      });
    } catch (err) {
      throw new AiError(`Could not reach ${cfg.baseUrl}: ${(err as Error).message}`, 'network');
    }

    const raw = await res.text();
    if (!res.ok) {
      throw new AiError(`${cfg.model} returned ${res.status}: ${shorten(raw)}`, 'provider');
    }

    let json: OpenAiResponse;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new AiError(`Unexpected response from ${cfg.baseUrl}: ${shorten(raw)}`, 'provider');
    }

    const text = json.choices?.[0]?.message?.content ?? '';
    if (!text) throw new AiError('The model returned an empty response.', 'provider');

    return {
      text,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  },
};

interface OpenAiResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

function shorten(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

registerAdapter(openAiCompatibleAdapter);
