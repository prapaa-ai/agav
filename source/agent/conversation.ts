import type { Message, ContentBlock, InvocationReason } from "../providers/types.js";
import { COMPACTION_PLACEHOLDER_PREFIX } from "./internal-prompts.js";
import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  getContextLimits,
} from "../utils/tokens.js";

export class ConversationState {
  private messages: Message[] = [];
  private model = "";
  private contextWindow?: number;
  private _compacted = false;
  private _lastCompactionSummary = "";

  setModel(model: string): void {
    // A window resolved for the previous model says nothing about the new one,
    // so drop it and let the provider re-report.
    if (model !== this.model) this.contextWindow = undefined;
    this.model = model;
  }

  /**
   * Record the real context window reported by the provider, overriding the
   * name-based estimate. Ollama models are the motivating case: their names
   * carry no context information, so without this they fall back to a generic
   * 128k while the server is actually enforcing something far smaller.
   */
  setContextWindow(tokens: number | undefined): void {
    this.contextWindow = tokens !== undefined && tokens > 0 ? tokens : undefined;
  }

  getContextWindow(): number | undefined {
    return this.contextWindow;
  }

  addUserMessage(
    text: string,
    extraBlocks?: ContentBlock[],
    displayText?: string,
    sourceText?: string,
    invocationReason?: InvocationReason,
  ): void {
    const content: ContentBlock[] = [{ type: "text", text }];
    if (extraBlocks) {
      content.push(...extraBlocks);
    }
    this.messages.push({
      role: "user",
      content,
      ...(displayText ? { displayText } : {}),
      ...(sourceText ? { sourceText } : {}),
      ...(invocationReason ? { invocationReason } : {}),
    });
  }

  /**
   * A user turn the agent injects to steer itself. Flagged so the transcript
   * can leave it out — the model needs to see it, the user should not.
   */
  addInternalUserMessage(text: string): void {
    this.messages.push({ role: "user", content: [{ type: "text", text }], internal: true });
  }

  /**
   * Append a text block to the newest user message. Used to attach per-turn
   * environment context after the turn's message already exists, keeping
   * volatile text at the tail of the request where it cannot invalidate the
   * provider's prefix cache. No-op when the newest message is not a user turn.
   */
  appendToLastUserMessage(text: string): void {
    if (!text) return;
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== "user") return;
    last.content.push({ type: "text", text });
  }

  /**
   * Insert a mid-turn user message (e.g. a /steer directive) into the running
   * conversation. Placement is protocol-constrained: providers such as
   * Anthropic reject any user message that lands between an assistant tool_use
   * and its matching tool_result, so the message is inserted after the last
   * complete tool cycle. When no tool results are pending — including an empty
   * history, which would otherwise start with two user turns in a row — it is
   * appended to the end instead.
   */
  injectUserMessage(text: string): void {
    if (!text.trim()) return;

    const answeredToolIds = new Set<string>();
    for (const msg of this.messages) {
      if (msg.role !== "user") continue;
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.toolCallId) {
          answeredToolIds.add(block.toolCallId);
        }
      }
    }

    // Walk back past trailing assistant tool_use blocks whose answers have not
    // been added yet; insertion must land after their tool_results do.
    let insertAt = this.messages.length;
    while (insertAt > 0) {
      const msg = this.messages[insertAt - 1]!;
      if (msg.role !== "assistant") break;
      const hasPendingToolUse = msg.content.some(
        (block) => block.type === "tool_use" && block.toolCallId && !answeredToolIds.has(block.toolCallId),
      );
      if (!hasPendingToolUse) break;
      insertAt--;
    }

    const injected: Message = {
      role: "user",
      content: [{ type: "text", text }],
      internal: true,
    };
    this.messages.splice(insertAt, 0, injected);
  }

  addAssistantMessage(content: ContentBlock[]): void {
    this.messages.push({ role: "assistant", content });
  }

  addToolResults(results: ContentBlock[]): void {
    this.messages.push({ role: "user", content: results });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this._compacted = false;
  }

  get length(): number {
    return this.messages.length;
  }

  get tokenCount(): number {
    return estimateConversationTokens(this.messages);
  }

  get wasCompacted(): boolean {
    return this._compacted;
  }

  get lastCompactionSummary(): string {
    return this._lastCompactionSummary;
  }

  setMessages(messages: Message[], compacted?: boolean): void {
    this.messages = this.sanitizeMessages([...messages]);
    if (compacted !== undefined) this._compacted = compacted;
  }

  private sanitizeMessages(messages: Message[]): Message[] {
    const toolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant") {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.toolCallId) {
            toolCallIds.add(block.toolCallId);
          }
        }
      }
    }
    return messages.map((msg) => {
      const filtered = msg.content.filter((block) => {
        // Providers reject an empty text block outright, so one saved into a
        // session file would make every later request fail until the session
        // was abandoned. Drop it here and the session loads clean again.
        if (block.type === "text" && !block.text?.trim()) return false;
        if (msg.role === "user" && block.type === "tool_result" && block.toolCallId) {
          return toolCallIds.has(block.toolCallId);
        }
        return true;
      });
      if (filtered.length === 0) return null;
      if (filtered.length === msg.content.length) return msg;
      return { ...msg, content: filtered };
    }).filter((msg): msg is Message => msg !== null);
  }

  /**
   * Walk a split point backwards until it no longer cuts a tool cycle in half.
   * Both halves are used as standalone conversations — the dropped half is sent
   * off to be summarized, the kept half becomes the new history — and providers
   * reject either one if a tool_result has lost its tool_use. Moving the
   * boundary onto the assistant turn that opened the cycle keeps the pair
   * together on the same side.
   */
  private safeSplitPoint(index: number): number {
    let split = index;
    while (split > 0 && this.messages[split]!.content.some((block) => block.type === "tool_result")) {
      split--;
    }
    return split;
  }

  private trimToolResults(targetTokens: number, preserveRecent: number): number {
    let freed = 0;
    const trimBoundary = Math.max(0, this.messages.length - preserveRecent);

    for (let i = 0; i < trimBoundary; i++) {
      const msg = this.messages[i]!;
      if (msg.role !== "user") continue;

      for (const block of msg.content) {
        if (block.type === "tool_result" && block.toolResult && block.toolResult.length > 500) {
          const before = estimateTokens(block.toolResult);
          block.toolResult = block.toolResult.slice(0, 200) + "\n...(trimmed)";
          block.toolResultContent = undefined;
          freed += before - estimateTokens(block.toolResult);
        }
      }

      if (this.tokenCount <= targetTokens) break;
    }
    return freed;
  }

  async compactIfNeeded(
    force = false,
    summarize?: (messages: Message[]) => Promise<string>,
  ): Promise<{ compacted: boolean; droppedCount: number; summary?: string }> {
    const limits = getContextLimits(this.model, this.contextWindow);
    const currentTokens = this.tokenCount;

    if (!force && currentTokens < limits.warningThreshold) {
      return { compacted: false, droppedCount: 0 };
    }

    // Phase 1: Trim old tool results before dropping messages
    this.trimToolResults(limits.warningThreshold, 8);
    if (!force && this.tokenCount < limits.warningThreshold) {
      return { compacted: false, droppedCount: 0 };
    }

    if (this.messages.length <= 4) {
      return { compacted: false, droppedCount: 0 };
    }

    // When forced, drop roughly half the messages; otherwise keep what fits in 60% of context
    const targetTokens = force
      ? Math.floor(currentTokens * 0.5)
      : Math.floor(limits.maxTokens * 0.6);
    let keepFrom = this.messages.length;
    let runningTokens = 0;

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msgTokens = estimateMessageTokens(this.messages[i]!);
      if (runningTokens + msgTokens > targetTokens) break;
      runningTokens += msgTokens;
      keepFrom = i;
    }

    // Keep at least the last 4 messages
    keepFrom = Math.min(keepFrom, Math.max(0, this.messages.length - 4));
    keepFrom = this.safeSplitPoint(keepFrom);

    if (keepFrom <= 0) {
      return { compacted: false, droppedCount: 0 };
    }

    const droppedCount = keepFrom;
    const droppedMessages = this.messages.slice(0, keepFrom);
    const userMsgCount = droppedMessages.filter((m) => m.role === "user").length;

    const placeholder = `${COMPACTION_PLACEHOLDER_PREFIX} (${userMsgCount} exchanges) was compacted to save context. Continue from here.]`;
    let summaryText = placeholder;

    if (summarize) {
      try {
        summaryText = await summarize(droppedMessages);
      } catch {
        summaryText = placeholder;
      }
    }

    // A blank summary would become an empty text block, which providers reject
    // outright ("text content blocks must be non-empty") — so every message
    // sent after the compaction fails, not just this one.
    if (!summaryText.trim()) summaryText = placeholder;

    // The summary stands in for turns the user did type, but it is written by
    // the agent — showing it verbatim as a user message is how a resumed
    // transcript ends up quoting instructions back at the user.
    const summary: Message = {
      role: "user",
      content: [{ type: "text", text: summaryText }],
      internal: true,
    };

    this.messages = this.sanitizeMessages([summary, ...this.messages.slice(keepFrom)]);
    this._compacted = true;
    this._lastCompactionSummary = summaryText;

    return { compacted: true, droppedCount, summary: summaryText };
  }
}
