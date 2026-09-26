import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { Receipt, Trigger } from "../types.js";

export interface LogInput {
  tool: string;
  input: unknown;
  result: unknown;
  trigger: Trigger;
  performed: boolean;
  status: string;
}

/**
 * The tool-call logger (Phase 1) and the source of Receipts (Phase 4). EVERY
 * tool call is recorded: time, tool, input, result, what triggered it, whether
 * it actually performed, and a status. A receipt code writes is evidence; a
 * receipt the model writes would only be a claim.
 */
export class ReceiptsRepo {
  private readonly receipts: Receipt[] = [];
  constructor(private readonly clock: Clock) {}

  log(input: LogInput): Receipt {
    const r: Receipt = {
      id: newId("rcpt"),
      at: this.clock.nowIso(),
      tool: input.tool,
      inputJson: safeJson(input.input),
      resultJson: safeJson(input.result),
      trigger: input.trigger,
      performed: input.performed,
      status: input.status,
    };
    this.receipts.push(r);
    return r;
  }

  /** receipts_query: what did you do in this window? */
  query(opts: { fromIso?: string; toIso?: string; tool?: string } = {}): Receipt[] {
    const from = opts.fromIso ? new Date(opts.fromIso).getTime() : -Infinity;
    const to = opts.toIso ? new Date(opts.toIso).getTime() : Infinity;
    return this.receipts.filter((r) => {
      const t = new Date(r.at).getTime();
      if (t < from || t > to) return false;
      if (opts.tool && r.tool !== opts.tool) return false;
      return true;
    });
  }

  all(): Receipt[] {
    return [...this.receipts];
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify(String(v));
  }
}
