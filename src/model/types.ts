/** OpenAI-compatible chat message / tool-calling shapes, kept minimal. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as the model emitted them. */
  argumentsJson: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that call tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages: which call this answers. */
  toolCallId?: string;
  /** Present on tool messages: the tool name, for logging. */
  name?: string;
}

/** JSON-schema-ish parameter description passed to the model. */
export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolSchema;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

export interface ModelResponse {
  /** Assistant free-text reply. Empty string when the model only calls tools. */
  content: string;
  /** Tool calls the model wants executed this turn. May be several. */
  toolCalls: ToolCall[];
}

/**
 * The one interface the agent core talks to. A real DeepSeek adapter and a
 * scripted fake both implement it. No keyword fallback ever implements it: if
 * there is no key, construction fails loudly (see MissingModelKeyError).
 */
export interface Model {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class MissingModelKeyError extends Error {
  constructor() {
    super(
      "No DEEPSEEK_API_KEY configured. There is no model. Jarvis will not " +
        "answer with a keyword bot pretending to be the model.",
    );
    this.name = "MissingModelKeyError";
  }
}

export class ModelCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCallError";
  }
}
