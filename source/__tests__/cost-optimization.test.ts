import { describe, it, expect, vi } from "vitest";

import { ConversationState } from "../agent/conversation.js";
import type { AgavConfig } from "../config/config.js";
import type { ContentBlock, Message } from "../providers/types.js";

/**
 * Covers the real, shipped cost-optimization behavior:
 *  1. Anthropic caches the conversation-history prefix (rolling cache_control).
 *  2. `tokenBudget` is a valid, typed config field.
 *  3. Compaction still runs the cheap summarizer and keeps its result.
 */

// --- Mock the Anthropic SDK so we can inspect the outgoing request ---------
let capturedRequest: any = null;
const streamMock = vi.fn((req: any) => {
  capturedRequest = req;
  return (async function* () {
    yield { type: "message_start", message: { usage: { input_tokens: 10 } } };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
  })();
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { stream: streamMock };
    constructor(_opts: any) {}
  },
}));

const { AnthropicProvider } = await import("../providers/anthropic.js");

function drain(iter: AsyncIterable<unknown>): Promise<void> {
  return (async () => {
    for await (const _ of iter) { /* consume */ }
  })();
}

function buildConversation(cycles: number): ConversationState {
  const convo = new ConversationState();
  convo.setModel("test");
  for (let i = 0; i < cycles; i++) {
    convo.addUserMessage(`question ${i} `.repeat(200));
    convo.addAssistantMessage([
      { type: "tool_use", toolCallId: `call-${i}`, toolName: "read_file", toolInput: { path: `f${i}.ts` } } as ContentBlock,
    ]);
    convo.addToolResults([
      { type: "tool_result", toolCallId: `call-${i}`, toolResult: `contents ${i} `.repeat(200) } as ContentBlock,
    ]);
  }
  return convo;
}

describe("cost optimization", () => {
  it("AgavConfig accepts a tokenBudget field", () => {
    const config: Pick<AgavConfig, "tokenBudget"> = { tokenBudget: 200000 };
    expect(config.tokenBudget).toBe(200000);
  });

  it("Anthropic marks a rolling cache breakpoint on the history prefix", async () => {
    capturedRequest = null;
    const provider = new AnthropicProvider("test-key");
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
    ];

    await drain(provider.stream({ model: "claude-sonnet-4-5", messages }));

    const sent = capturedRequest.messages;
    // Second-to-last message's last block carries the cache breakpoint...
    expect(sent[1].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    // ...and the newest turn does NOT (it changes every request).
    expect(sent[2].content.at(-1).cache_control).toBeUndefined();
  });

  it("does not add a history breakpoint for very short conversations", async () => {
    capturedRequest = null;
    const provider = new AnthropicProvider("test-key");
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    await drain(provider.stream({ model: "claude-sonnet-4-5", messages }));

    for (const m of capturedRequest.messages) {
      for (const b of m.content) expect(b.cache_control).toBeUndefined();
    }
  });

  it("compaction invokes the (cheap) summarizer and keeps its result", async () => {
    const convo = buildConversation(8);
    let received: Message[] | null = null;

    const result = await convo.compactIfNeeded(true, async (msgs) => {
      received = msgs;
      return "Task: X. Changed src/a.ts. Error: boom. Remaining: none.";
    });

    expect(result.compacted).toBe(true);
    expect(received).not.toBeNull();
    expect((received as unknown as Message[]).length).toBeGreaterThan(0);
    expect(convo.lastCompactionSummary).toContain("src/a.ts");
    expect(convo.lastCompactionSummary).toContain("boom");
  });
});
