import { describe, it, expect } from "vitest";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";
import { FAST_MODELS, DEEP_MODELS } from "../commands/model-routing.js";
import { canSuggestModel, heuristicTier, parseClassifierReply, suggestModel } from "../utils/model-suggestion.js";

const baseConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  effort: "high",
  permissionMode: "ask",
  maxTokens: 16384,
  maxIterations: 800,
  errorRetries: 5,
} as AgavConfig;

function providerReplying(events: StreamEvent[] | Error): LLMProvider {
  return {
    name: "fake",
    async *stream() {
      if (events instanceof Error) throw events;
      yield* events;
    },
  };
}

describe("parseClassifierReply", () => {
  it("reads tier and reason", () => {
    expect(parseClassifierReply("deep: multi-file refactor")).toEqual({ tier: "deep", reason: "multi-file refactor" });
    expect(parseClassifierReply("`fast: quick lookup`")).toEqual({ tier: "fast", reason: "quick lookup" });
  });

  it("rejects replies without a tier", () => {
    expect(parseClassifierReply("I am not sure")).toBeNull();
  });
});

describe("heuristicTier", () => {
  it("picks deep for engineering work and fast for short questions", () => {
    expect(heuristicTier("refactor the auth module").tier).toBe("deep");
    expect(heuristicTier("what does this regex match?").tier).toBe("fast");
  });
});

describe("canSuggestModel", () => {
  it("respects the opt-out, org pins, and providers without tiers", () => {
    expect(canSuggestModel(baseConfig)).toBe(true);
    expect(canSuggestModel({ ...baseConfig, modelSuggestions: false })).toBe(false);
    expect(canSuggestModel({ ...baseConfig, orgManagedModel: "x" })).toBe(false);
    expect(canSuggestModel({ ...baseConfig, provider: "ollama" })).toBe(false);
  });
});

describe("suggestModel", () => {
  it("maps the AI's tier to the provider's model", async () => {
    const provider = providerReplying([{ type: "text_delta", text: "fast: simple question" }]);
    const result = await suggestModel(provider, baseConfig, "what is 2+2");
    expect(result).toEqual({ tier: "fast", model: FAST_MODELS.anthropic, reason: "simple question", effort: "low", source: "ai" });
  });

  it("falls back to the heuristic when the classifier fails", async () => {
    const result = await suggestModel(providerReplying(new Error("boom")), baseConfig, "debug the flaky test suite");
    expect(result).toMatchObject({ tier: "deep", model: DEEP_MODELS.anthropic, effort: "high", source: "heuristic" });
  });
});
