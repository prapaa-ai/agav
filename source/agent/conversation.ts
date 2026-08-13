import type { Message, ContentBlock, InvocationReason } from "../providers/types.js";
import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  getContextLimits,
} from "../utils/tokens.js";

export class ConversationState {
  private messages: Message[] = [];
  private model = "";
  private _compacted = false;
  private _lastCompactionSummary = "";

  setModel(model: string): void {
    this.model = model;
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
      if (msg.role === "user") {
        const filtered = msg.content.filter((block) => {
          if (block.type === "tool_result" && block.toolCallId) {
            return toolCallIds.has(block.toolCallId);
          }
          return true;
        });
        if (filtered.length === 0) return null;
        return { ...msg, content: filtered };
      }
      return msg;
    }).filter((msg): msg is Message => msg !== null);
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
    const limits = getContextLimits(this.model);
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

    if (keepFrom <= 0) {
      return { compacted: false, droppedCount: 0 };
    }

    const droppedCount = keepFrom;
    const droppedMessages = this.messages.slice(0, keepFrom);
    const userMsgCount = droppedMessages.filter((m) => m.role === "user").length;

    let summaryText: string;

    if (summarize) {
      try {
        summaryText = await summarize(droppedMessages);
      } catch {
        summaryText = `[Earlier conversation (${userMsgCount} exchanges) was compacted to save context. Continue from here.]`;
      }
    } else {
      summaryText = `[Earlier conversation (${userMsgCount} exchanges) was compacted to save context. Continue from here.]`;
    }

    const summary: Message = {
      role: "user",
      content: [{ type: "text", text: summaryText }],
    };

    this.messages = [summary, ...this.messages.slice(keepFrom)];
    this._compacted = true;
    this._lastCompactionSummary = summaryText;

    return { compacted: true, droppedCount, summary: summaryText };
  }
}
