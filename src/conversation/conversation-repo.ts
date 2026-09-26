import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import type { Channel, StoredMessage } from "../types.js";

/**
 * Conversation store. Recent messages are kept in full; when the transcript
 * grows past a size cap (a system-protection limit, NOT a judgment about what
 * matters) code TRIGGERS a summary. The MODEL writes the summary text — code
 * never decides what to keep.
 *
 * The SAME store serves text and voice (brief: the first build kept two stores
 * with no bridge, so calls remembered nothing).
 */
export class ConversationRepo {
  private readonly messages: StoredMessage[] = [];
  constructor(
    private readonly clock: Clock,
    /** Runaway cap: summarize when more than this many un-summarized messages exist. */
    private readonly summaryThreshold = 40,
  ) {}

  append(role: "user" | "assistant", content: string, channel: Channel): StoredMessage {
    const m: StoredMessage = {
      id: newId("msg"),
      role,
      content,
      channel,
      createdAt: this.clock.nowIso(),
    };
    this.messages.push(m);
    return m;
  }

  /** All messages (any channel), oldest first. */
  all(): StoredMessage[] {
    return [...this.messages];
  }

  /** Recent window for the model context. */
  recent(limit = 30): StoredMessage[] {
    return this.messages.slice(-limit);
  }

  /** Literal search over past conversation, both Sid's and Jarvis's words. */
  literalSearch(query: string): StoredMessage[] {
    const q = query.toLowerCase();
    return this.messages.filter((m) => m.content.toLowerCase().includes(q));
  }

  /** Code decides ONLY that the transcript is too long, never what matters. */
  needsSummary(): boolean {
    const unsummarized = this.messages.filter((m) => !m.isSummary).length;
    return unsummarized > this.summaryThreshold;
  }

  /**
   * Replace the oldest `count` messages with a single summary the MODEL wrote.
   * Returns the messages that were rolled up (so a caller can archive them).
   */
  applySummary(summaryText: string, count: number): StoredMessage[] {
    const toRoll = this.messages.slice(0, count);
    const summary: StoredMessage = {
      id: newId("sum"),
      role: "assistant",
      content: summaryText,
      channel: "text",
      createdAt: this.clock.nowIso(),
      isSummary: true,
    };
    this.messages.splice(0, count, summary);
    return toRoll;
  }
}
