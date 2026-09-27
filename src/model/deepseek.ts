import type {
  ChatMessage,
  Model,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "./types.js";
import { MissingModelKeyError, ModelCallError } from "./types.js";

const API_ORIGIN = "https://api.deepseek.com";
/**
 * Sid chose DeepSeek V4.1 Flash for every path. The fallback must AGREE with
 * that decision: an unset binding must not silently run a different model.
 */
export const DEFAULT_MODEL = "deepseek-flash";

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Trap #1 from the brief: an unbound fetch throws "Illegal invocation" in
   * production while every mocked test passes. Always bind it.
   */
  fetchImpl?: typeof fetch;
  firstTokenTimeoutMs?: number;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * DeepSeek adapter over the OpenAI-compatible chat completions API.
 *
 * There is deliberately no keyword fallback. If apiKey is empty the constructor
 * throws MissingModelKeyError, so a deployment without a key fails loudly rather
 * than quietly degrading to a bot that reads Sid's words with regexes.
 */
export class DeepSeekModel implements Model {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly firstTokenTimeoutMs: number;

  constructor(opts: DeepSeekOptions) {
    if (!opts.apiKey || opts.apiKey.trim() === "") {
      throw new MissingModelKeyError();
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model && opts.model.trim() !== "" ? opts.model : DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? API_ORIGIN;
    // Trap #1: bind fetch to globalThis so it does not throw "Illegal invocation".
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 30_000;
  }

  get name(): string {
    return this.model;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toWireMessage),
    };
    // OpenAI-compatible APIs reject an empty `tools` array (and `tool_choice`
    // without tools) with a 400. Tool-less requests — guest calls, conversation
    // summaries, memory reviews — must omit both.
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.firstTokenTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ModelCallError(`DeepSeek request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ModelCallError(`DeepSeek returned ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as any;
    const choice = json?.choices?.[0];
    if (!choice) {
      throw new ModelCallError("DeepSeek response had no choices");
    }
    const message = choice.message ?? {};
    const wireCalls: WireToolCall[] = message.tool_calls ?? [];
    const toolCalls: ToolCall[] = wireCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      argumentsJson: c.function.arguments ?? "{}",
    }));
    return {
      content: typeof message.content === "string" ? message.content : "",
      toolCalls,
    };
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.argumentsJson },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name };
  }
  return { role: m.role, content: m.content };
}
