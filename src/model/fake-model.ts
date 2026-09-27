import type { Model, ModelRequest, ModelResponse, ToolCall } from "./types.js";

/**
 * Scripted model for tests. It does NOT read Sid's words with keywords — it
 * plays back a queue of pre-authored responses, or defers to a function that
 * inspects the request. This lets a test drive the exact tool-calling path it
 * wants to assert, without any real model.
 */
export type ScriptedTurn =
  | { content: string; toolCalls?: ToolCall[] }
  | ((req: ModelRequest) => ModelResponse);

let counter = 0;
export function fakeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  counter += 1;
  return { id: `call_${counter}`, name, argumentsJson: JSON.stringify(args) };
}

export class FakeModel implements Model {
  private readonly turns: ScriptedTurn[];
  public readonly requests: ModelRequest[] = [];

  constructor(
    turns: ScriptedTurn[],
    public readonly name = "fake-model",
  ) {
    this.turns = [...turns];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (turn === undefined) {
      // No more scripted turns: end the loop with an empty final reply.
      return { content: "", toolCalls: [] };
    }
    if (typeof turn === "function") {
      return turn(request);
    }
    return { content: turn.content ?? "", toolCalls: turn.toolCalls ?? [] };
  }
}
