import { describe, it, expect, vi } from "vitest";

import type { Message } from "../providers/types.js";
import { estimateTokens, estimateMessageTokens, estimateConversationTokens, getContextLimits } from "../utils/tokens.js";

describe("utils/tokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates mixed text and symbol-heavy content", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a+b=c")).toBe(5);
  });

  it("counts message blocks, including nested tool result content", () => {
    const message: Message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "hello world",
          toolResult: "unused",
          toolInput: { path: "/tmp/file" },
          toolName: "read_file",
          toolCallId: "call_1",
          imageData: "abcd",
          toolResultContent: [{ type: "text", text: "nested result" }],
        },
      ],
    };

    expect(estimateMessageTokens(message)).toBeGreaterThan(4);
    expect(estimateConversationTokens([message])).toBe(estimateMessageTokens(message));
  });

  it("uses toolResult only when toolResultContent is absent", () => {
    const withResultOnly: Message = { role: "user", content: [{ type: "tool_result", toolResult: "abc" }] };
    const withNestedContent: Message = {
      role: "user",
      content: [{ type: "tool_result", toolResult: "abc", toolResultContent: [{ type: "text", text: "x" }] }],
    };

    expect(estimateMessageTokens(withResultOnly)).toBeGreaterThan(4);
    expect(estimateMessageTokens(withNestedContent)).toBeGreaterThan(estimateMessageTokens(withResultOnly));
  });

  it("returns model-specific context limits", () => {
    expect(getContextLimits("claude-opus-5")).toEqual({ maxTokens: 1_000_000, warningThreshold: 800_000 });
    expect(getContextLimits("claude-opus-4-5")).toEqual({ maxTokens: 200_000, warningThreshold: 160_000 });
    expect(getContextLimits("claude-haiku-4-5")).toEqual({ maxTokens: 200_000, warningThreshold: 160_000 });
    expect(getContextLimits("gpt-5.4")).toEqual({ maxTokens: 1_000_000, warningThreshold: 800_000 });
    expect(getContextLimits("gpt-5.4-mini")).toEqual({ maxTokens: 400_000, warningThreshold: 320_000 });
    expect(getContextLimits("gpt-4o")).toEqual({ maxTokens: 128_000, warningThreshold: 100_000 });
    expect(getContextLimits("gpt-4-turbo")).toEqual({ maxTokens: 128_000, warningThreshold: 100_000 });
    expect(getContextLimits("unknown-model")).toEqual({ maxTokens: 128_000, warningThreshold: 100_000 });
  });
});
