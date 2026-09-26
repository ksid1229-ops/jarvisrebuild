import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSettings, saveSettings } from '../src/common/db';
import {
  AiError,
  complete,
  describeCall,
  estimateCost,
  estimateTokens,
  monthKey,
  monthlySpend,
} from '../src/ai';
import { isLocalEndpoint } from '../src/common/settings';
import { encryptSecret, decryptSecret, maskKey, scrubSecrets } from '../src/common/crypto';

beforeEach(async () => {
  await db.aiCalls.clear();
  await db.settings.clear();
});

describe('local-only endpoint detection', () => {
  it('knows which endpoints stay on the machine', () => {
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false);
  });
});

describe('key handling', () => {
  it('round-trips an encrypted key and never shows it in full', async () => {
    const cipher = await encryptSecret('sk-test-1234567890abcdef');
    expect(cipher).not.toContain('sk-test');
    expect(await decryptSecret(cipher)).toBe('sk-test-1234567890abcdef');
    expect(maskKey('sk-test-1234567890abcdef')).toBe('••••••••cdef');
  });

  it('scrubs key-shaped strings before anything is logged', () => {
    expect(scrubSecrets('failed with sk-abcdefghijklmnopqrstuvwx')).toContain('sk-REDACTED');
    expect(scrubSecrets('Authorization: Bearer abcdefghijkl')).toContain('Bearer REDACTED');
  });
});

describe('cost estimation', () => {
  it('estimates tokens and cost per call', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    const cfg = {
      kind: 'openai-compatible' as const,
      label: 'x',
      baseUrl: '',
      model: 'm',
      isLocal: false,
      inputCostPerMTok: 2,
      outputCostPerMTok: 10,
    };
    expect(estimateCost(cfg, 1_000_000, 100_000)).toBeCloseTo(3);
  });

  it('rolls up spend for the current month only', async () => {
    const lastMonth = Date.parse('2026-08-15T00:00:00Z');
    await db.aiCalls.bulkPut([
      {
        id: '1',
        at: Date.now(),
        role: 'cheap',
        providerLabel: 'p',
        baseUrl: '',
        model: 'm',
        feature: 'other',
        promptTokens: 100,
        completionTokens: 50,
        estimatedCostUsd: 0.01,
        ok: true,
      },
      {
        id: '2',
        at: lastMonth,
        role: 'cheap',
        providerLabel: 'p',
        baseUrl: '',
        model: 'm',
        feature: 'other',
        promptTokens: 100,
        completionTokens: 50,
        estimatedCostUsd: 5,
        ok: true,
      },
    ]);
    const spend = await monthlySpend();
    expect(spend.calls).toBe(1);
    expect(spend.usd).toBeCloseTo(0.01);
    expect(monthKey(lastMonth)).toBe('2026-08');
  });
});

describe('pre-call disclosure', () => {
  it('reports the exact host, model and payload that would be sent', async () => {
    await getSettings();
    const info = await describeCall({
      role: 'strong',
      feature: 'other',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(info.host).toBe('api.openai.com');
    expect(info.isLocal).toBe(false);
    expect(info.preview).toContain('hello world');
  });
});

describe('privacy and budget gates', () => {
  it('BLOCKS a remote call when "local model only" is on', async () => {
    await saveSettings({ localModelOnly: true, confirmBeforeAiCall: false });
    await expect(
      complete({ role: 'strong', feature: 'other', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/local model only/i);
  });

  it('BLOCKS a call that has not been disclosed to the user', async () => {
    await saveSettings({ confirmBeforeAiCall: true });
    await expect(
      complete({ role: 'strong', feature: 'other', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/confirmation/i);
  });

  it('BLOCKS a call that would break the monthly budget', async () => {
    await saveSettings({ confirmBeforeAiCall: false, monthlyBudgetUsd: 0.0001 });
    await db.aiCalls.put({
      id: 'x',
      at: Date.now(),
      role: 'strong',
      providerLabel: 'p',
      baseUrl: '',
      model: 'm',
      feature: 'other',
      promptTokens: 1,
      completionTokens: 1,
      estimatedCostUsd: 1,
      ok: true,
    });
    await expect(
      complete({ role: 'strong', feature: 'other', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/budget/i);
  });

  it('refuses when no API key is saved for a remote provider', async () => {
    await saveSettings({ confirmBeforeAiCall: false, monthlyBudgetUsd: null });
    await expect(
      complete({
        role: 'strong',
        feature: 'other',
        disclosureAccepted: true,
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/API key/i);
  });
});

describe('openai-compatible adapter', () => {
  it('posts the OpenAI shape and records usage and cost', async () => {
    const settings = await getSettings();
    await saveSettings({
      confirmBeforeAiCall: false,
      monthlyBudgetUsd: null,
      providers: {
        ...settings.providers,
        cheap: { ...settings.providers.cheap, apiKeyCipher: await encryptSecret('sk-live-key') },
      },
    });

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-live-key');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('deepseek-chat');
      expect(body.stream).toBe(false);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ready' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await complete({
      role: 'cheap',
      feature: 'other',
      disclosureAccepted: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.text).toBe('ready');
    expect(out.promptTokens).toBe(12);
    expect(out.estimatedCostUsd).toBeGreaterThan(0);
    expect((await db.aiCalls.toArray())[0].ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('surfaces provider errors and logs the failure without the key', async () => {
    const settings = await getSettings();
    await saveSettings({
      confirmBeforeAiCall: false,
      monthlyBudgetUsd: null,
      providers: {
        ...settings.providers,
        cheap: { ...settings.providers.cheap, apiKeyCipher: await encryptSecret('sk-live-key') },
      },
    });
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"error":{"message":"bad key sk-live-key"}}', { status: 401 }),
    );
    await expect(
      complete({
        role: 'cheap',
        feature: 'other',
        disclosureAccepted: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError);
    const logged = await db.aiCalls.toArray();
    expect(logged[0].ok).toBe(false);
    expect(logged[0].error).not.toContain('sk-live-key');
    vi.unstubAllGlobals();
  });
});

describe('anthropic adapter', () => {
  it('lifts the system prompt out and uses x-api-key', async () => {
    const settings = await getSettings();
    await saveSettings({
      confirmBeforeAiCall: false,
      monthlyBudgetUsd: null,
      providers: {
        ...settings.providers,
        strong: {
          kind: 'anthropic',
          label: 'Anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-20250514',
          isLocal: false,
          inputCostPerMTok: 3,
          outputCostPerMTok: 15,
          apiKeyCipher: await encryptSecret('sk-ant-key'),
        },
      },
    });

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      const body = JSON.parse(init.body as string);
      expect(body.system).toBe('be brief');
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await complete({
      role: 'strong',
      feature: 'other',
      disclosureAccepted: true,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(out.text).toBe('ok');
    vi.unstubAllGlobals();
  });
});
