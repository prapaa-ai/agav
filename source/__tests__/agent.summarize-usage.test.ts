import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";

// Providers can report input/cache usage at message start and output usage at
// message end. Compaction must account for both, even if the stream then fails.
describe("summarizer split usage accounting", () => {
  it.each([
    ["automatic", false],
    ["automatic", true],
    ["overflow recovery", false],
    ["overflow recovery", true],
  ] as const)("retains all usage during %s (summarizer throws: %s)", async (path, fails) => {
    const conversation = new ConversationState();
    conversation.setModel("mock");
    if (path === "automatic") conversation.setContextWindow(1000);
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) conversation.addUserMessage("context ".repeat(100));
      else conversation.addAssistantMessage([{ type: "text", text: "response ".repeat(100) }]);
    }

    let normalRequests = 0;
    let summaryRequests = 0;
    const provider: LLMProvider = {
      name: "mock",
      stream: vi.fn((params: StreamParams) => (async function* (): AsyncGenerator<StreamEvent> {
        if (params.systemPrompt?.startsWith("Summarize this conversation")) {
          summaryRequests++;
          yield { type: "usage", inputTokens: 100, outputTokens: 0, cacheReadTokens: 7 };
          yield { type: "text_delta", text: "summary" };
          yield { type: "usage", inputTokens: 0, outputTokens: 9, cacheWriteTokens: 3 };
          if (fails) throw new Error("summarizer disconnected");
        } else {
          normalRequests++;
          if (path === "overflow recovery" && normalRequests === 1) {
            throw new Error("context window exceeded");
          }
          yield { type: "text_delta", text: "done" };
          yield { type: "usage", inputTokens: 11, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 };
        }
        yield { type: "message_end", stopReason: "end_turn" };
      })()),
    };

    const events: AgentEvent[] = [];
    for await (const event of runAgentLoop({
      provider, conversation, toolRegistry: new ToolRegistry(), model: "mock",
      iterationsBudget: { remaining: 3, total: 3 },
    })) events.push(event);

    expect(summaryRequests).toBe(1);
    expect(normalRequests).toBe(path === "automatic" ? 1 : 2);
    expect(events.filter(event => event.type === "compacted")).toHaveLength(1);
    expect(events.filter(event => event.type === "usage")).toEqual([
      { type: "usage", inputTokens: 100, outputTokens: 9, cacheReadTokens: 7, cacheWriteTokens: 3 },
      { type: "usage", inputTokens: 11, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
    ]);
    expect(conversation.lastCompactionSummary).toContain(fails ? "compacted to save context" : "summary");
    expect(events.at(-1)).toEqual({ type: "turn_complete" });
  });
});
