import { describe, it, expect, beforeEach } from "vitest";
import {
  detectModelFamily,
  countBpeTokens,
  getBpeStats,
  clearBpeCache,
  getBpeCacheSize,
} from "../utils/bpe-tokenizer.js";
import { ConversationState } from "../agent/conversation.js";
import type { ContentBlock } from "../providers/types.js";

describe("P2.3 - Exact BPE Tokenizer & Proactive Context Compaction", () => {
  beforeEach(() => {
    clearBpeCache();
  });

  describe("Model Family Detection", () => {
    it("detects OpenAI models", () => {
      expect(detectModelFamily("gpt-4o")).toBe("openai");
      expect(detectModelFamily("gpt-5.4-mini")).toBe("openai");
      expect(detectModelFamily("o1-mini")).toBe("openai");
    });

    it("detects Anthropic Claude models", () => {
      expect(detectModelFamily("claude-sonnet-4-5")).toBe("anthropic");
      expect(detectModelFamily("claude-opus-5")).toBe("anthropic");
      expect(detectModelFamily("claude-haiku-4-5")).toBe("anthropic");
    });

    it("detects Llama and Groq models", () => {
      expect(detectModelFamily("llama-3.3-70b-versatile")).toBe("llama");
      expect(detectModelFamily("groq/llama-3.1-8b-instant")).toBe("llama");
      expect(detectModelFamily("deepseek-chat")).toBe("llama");
    });

    it("detects Gemini models", () => {
      expect(detectModelFamily("gemini-2.5-pro")).toBe("gemini");
    });

    it("falls back to default for unrecognized models", () => {
      expect(detectModelFamily("custom-local-model")).toBe("default");
      expect(detectModelFamily(undefined)).toBe("default");
    });
  });

  describe("BPE Token Counting", () => {
    it("returns 0 for empty or falsy strings", () => {
      expect(countBpeTokens("")).toBe(0);
      expect(countBpeTokens(null as any)).toBe(0);
      expect(countBpeTokens(undefined as any)).toBe(0);
    });

    it("counts tokens for basic sentences and code", () => {
      const tokens = countBpeTokens("function calculateSum(a: number, b: number): number { return a + b; }", "openai");
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(50);
    });

    it("handles multi-byte Unicode and CJK characters", () => {
      const asciiTokens = countBpeTokens("hello", "openai");
      const cjkTokens = countBpeTokens("你好世界", "openai");
      // CJK characters take 2-3 bytes each, resulting in more tokens
      expect(cjkTokens).toBeGreaterThan(asciiTokens);
    });

    it("handles number clustering correctly", () => {
      const tokens = countBpeTokens("123 456 7890", "openai");
      expect(tokens).toBeGreaterThanOrEqual(4);
    });

    it("computes comprehensive BPE stats", () => {
      const text = "Const greeting = 'Hello, World!';";
      const stats = getBpeStats(text, "claude-sonnet-4-5");
      expect(stats.chars).toBe(text.length);
      expect(stats.words).toBeGreaterThan(0);
      expect(stats.tokens).toBeGreaterThan(0);
      expect(stats.ratio).toBeGreaterThan(0);
    });

    it("uses memoization cache for identical blocks", () => {
      const text = "repeat this identical token string for memoization test";
      expect(getBpeCacheSize()).toBe(0);

      const count1 = countBpeTokens(text, "openai");
      expect(getBpeCacheSize()).toBeGreaterThan(0);

      const count2 = countBpeTokens(text, "openai");
      expect(count1).toBe(count2);

      clearBpeCache();
      expect(getBpeCacheSize()).toBe(0);
    });
  });

  describe("Proactive Context Trimming", () => {
    it("preserves tool outputs from the most recent 2 turns", () => {
      const conversation = new ConversationState();
      conversation.setModel("gpt-4o");

      // Turn 1 (most recent)
      conversation.addUserMessage("turn 1 request");
      const recentToolBlock: ContentBlock = {
        type: "tool_result",
        toolCallId: "call_recent",
        toolResult: "Line 1\nLine 2\nLine 3\n" + "long recent tool result ".repeat(30),
      };
      conversation.addToolResults([recentToolBlock]);

      const freed = conversation.proactiveTrimToolResults(2);
      expect(freed).toBe(0);
      // Recent result should be untouched
      const msgs = conversation.getMessages();
      const toolMsg = msgs.find((m) => m.content.some((b) => b.type === "tool_result"));
      expect(toolMsg?.content[0]?.toolResult).not.toContain("[Tool result:");
    });

    it("proactively trims large tool outputs older than 2 turns", () => {
      const conversation = new ConversationState();
      conversation.setModel("gpt-4o");

      // Turn 1 (old turn, > 2 turns ago)
      conversation.addUserMessage("old turn 1");
      const oldToolResult = "Old line 1\nOld line 2\n" + "Large old tool output line with lots of data\n".repeat(20);
      conversation.addToolResults([{ type: "tool_result", toolCallId: "c1", toolResult: oldToolResult }]);

      // Turn 2
      conversation.addUserMessage("turn 2");
      conversation.addAssistantMessage([{ type: "text", text: "step 2" }]);

      // Turn 3 (recent)
      conversation.addUserMessage("turn 3");
      conversation.addAssistantMessage([{ type: "text", text: "step 3" }]);

      // Turn 4 (most recent)
      conversation.addUserMessage("turn 4");

      const tokensBefore = conversation.tokenCount;
      const freed = conversation.proactiveTrimToolResults(2);

      expect(freed).toBeGreaterThan(0);
      expect(conversation.tokenCount).toBeLessThan(tokensBefore);

      // Verify old tool result contains compact summary
      const msgs = conversation.getMessages();
      const oldToolMsg = msgs[1]!;
      expect(oldToolMsg.content[0]?.toolResult).toContain("[Tool result:");
      expect(oldToolMsg.content[0]?.toolResult).toContain("lines,");
      expect(oldToolMsg.content[0]?.toolResult).toContain("bytes — trimmed to preserve context budget");
    });
  });
});
