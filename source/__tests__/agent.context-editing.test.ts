import { describe, expect, it } from "vitest";

import { ConversationState } from "../agent/conversation.js";
import type { ContentBlock, Message } from "../providers/types.js";

/**
 * Context editing (tool-result clearing): older, re-fetchable tool results are
 * replaced by a compact placeholder that names the tool, keeping the tool_use /
 * tool_result pairing intact and preserving the most recent results in full.
 */

// Realistic, varied tool output — the token estimator (rightly) undercounts a
// long run of one repeated character, so tests use word-like content.
function payload(words: number): string {
  const bank = ["const", "value", "return", "result", "import", "export", "function", "handler", "config", "module"];
  let out = "";
  for (let i = 0; i < words; i++) out += bank[i % bank.length] + " ";
  return out;
}

function buildConversation(cycles: number, resultWords = 800): ConversationState {
  const convo = new ConversationState();
  convo.setModel("claude-sonnet-4-5");
  for (let i = 0; i < cycles; i++) {
    convo.addUserMessage(`question ${i}`);
    convo.addAssistantMessage([
      { type: "tool_use", toolCallId: `call-${i}`, toolName: "read_file", toolInput: { path: `f${i}.ts` } } as ContentBlock,
    ]);
    convo.addToolResults([
      { type: "tool_result", toolCallId: `call-${i}`, toolResult: payload(resultWords) } as ContentBlock,
    ]);
  }
  return convo;
}

function toolResults(messages: Message[]): ContentBlock[] {
  return messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
}

describe("context editing — tool-result clearing", () => {
  it("clears older tool results and keeps the most recent ones full", () => {
    const convo = buildConversation(10);
    const freed = convo.clearStaleToolResults({ keepRecentResults: 4, minClearChars: 2000 });

    expect(freed).toBeGreaterThan(0);

    const results = toolResults(convo.getMessages());
    const cleared = results.filter((b) => b.toolResultCleared);
    const full = results.filter((b) => !b.toolResultCleared);

    // 10 results, keep 4 => 6 cleared.
    expect(cleared.length).toBe(6);
    expect(full.length).toBe(4);

    // The 4 kept-full ones are the most recent (call-6..call-9).
    expect(full.map((b) => b.toolCallId).sort()).toEqual(
      ["call-6", "call-7", "call-8", "call-9"],
    );
  });

  it("placeholder names the tool so the model can re-fetch", () => {
    const convo = buildConversation(6);
    convo.clearStaleToolResults({ keepRecentResults: 1, minClearChars: 2000 });

    const cleared = toolResults(convo.getMessages()).find((b) => b.toolResultCleared);
    expect(cleared?.toolResult).toContain("read_file");
    expect(cleared?.toolResult).toContain("cleared to save context");
    expect(cleared?.toolResultContent).toBeUndefined();
  });

  it("never breaks tool_use / tool_result pairing", () => {
    const convo = buildConversation(8);
    convo.clearStaleToolResults({ keepRecentResults: 2, minClearChars: 2000 });

    const useIds = new Set<string>();
    for (const m of convo.getMessages()) {
      for (const b of m.content) {
        if (b.type === "tool_use" && b.toolCallId) useIds.add(b.toolCallId);
      }
    }
    // Every tool_result (cleared or not) still has a matching tool_use.
    for (const r of toolResults(convo.getMessages())) {
      expect(useIds.has(r.toolCallId!)).toBe(true);
    }
  });

  it("is idempotent — a second pass clears nothing new", () => {
    const convo = buildConversation(10);
    const first = convo.clearStaleToolResults({ keepRecentResults: 4, minClearChars: 2000 });
    const second = convo.clearStaleToolResults({ keepRecentResults: 4, minClearChars: 2000 });

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it("leaves small tool results alone", () => {
    const convo = buildConversation(10, 5); // ~30-char results, below minClearChars
    const freed = convo.clearStaleToolResults({ keepRecentResults: 2, minClearChars: 2000 });

    expect(freed).toBe(0);
    expect(toolResults(convo.getMessages()).every((b) => !b.toolResultCleared)).toBe(true);
  });

  it("does nothing when there are fewer results than the keep window", () => {
    const convo = buildConversation(3);
    const freed = convo.clearStaleToolResults({ keepRecentResults: 4, minClearChars: 2000 });
    expect(freed).toBe(0);
  });

  it("shouldClearToolResults gates on token pressure", () => {
    const small = buildConversation(2);
    expect(small.shouldClearToolResults()).toBe(false);

    // Sonnet 4.5 window is 200k; 50% threshold is 100k. Build well past it
    // (~120 cycles * ~2000 words/result * ~1.3 tok/word).
    const big = buildConversation(120, 2000);
    expect(big.shouldClearToolResults()).toBe(true);
  });
});
