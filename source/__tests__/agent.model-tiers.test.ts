import { describe, expect, it } from "vitest";

import {
  FAST_MODELS,
  DEEP_MODELS,
  resolveFastModel,
  wouldRouteToFast,
  resolveTurnModelAsync,
} from "../agent/model-tiers.js";
import { PROVIDERS } from "../config/startup.js";

describe("model tiers / internal-call routing", () => {
  it("has a fast and deep tier for every cloud provider", () => {
    for (const provider of PROVIDERS) {
      if (provider === "ollama") continue; // local models are user-supplied
      expect(FAST_MODELS[provider], `fast for ${provider}`).toBeTypeOf("string");
      expect(DEEP_MODELS[provider], `deep for ${provider}`).toBeTypeOf("string");
    }
  });

  it("resolveFastModel returns the provider's cheap tier", () => {
    expect(resolveFastModel("anthropic", "claude-sonnet-4-20250514")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(resolveFastModel("openai", "gpt-4o")).toBe("gpt-4o-mini");
  });

  it("falls back to the current model when the provider has no fast tier", () => {
    // Ollama has no static table entry — must not break, just no cheaper model.
    expect(resolveFastModel("ollama", "llama3.2")).toBe("llama3.2");
  });

  it("wouldRouteToFast is false when already on the fast model or unknown", () => {
    expect(wouldRouteToFast("anthropic", "claude-sonnet-4-20250514")).toBe(true);
    expect(wouldRouteToFast("anthropic", "claude-haiku-4-5-20251001")).toBe(false);
    expect(wouldRouteToFast("ollama", "llama3.2")).toBe(false);
  });

  it("never routes a provider to another provider's model", () => {
    // The fast model for a non-OpenAI provider must not be a gpt-* model.
    for (const provider of PROVIDERS) {
      if (provider === "ollama" || provider === "openai") continue;
      const fast = FAST_MODELS[provider];
      if (fast) expect(fast).not.toMatch(/^gpt-/);
    }
  });
});

describe("resolveTurnModelAsync — model-backed routing", () => {
  const base = {
    provider: "anthropic" as const,
    currentModel: "claude-sonnet-4-20250514",
  };

  it("does not route when disabled", async () => {
    const r = await resolveTurnModelAsync({ ...base, text: "what is a closure?", enabled: false });
    expect(r.routed).toBe(false);
    expect(r.model).toBe(base.currentModel);
  });

  it("routes a simple lookup to the fast model when enabled", async () => {
    const r = await resolveTurnModelAsync({ ...base, text: "what is a closure?", enabled: true });
    expect(r.routed).toBe(true);
    expect(r.model).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps a hard task on the configured model", async () => {
    const r = await resolveTurnModelAsync({
      ...base,
      text: "refactor the auth module and fix the failing tests",
      enabled: true,
    });
    expect(r.routed).toBe(false);
    expect(r.model).toBe(base.currentModel);
  });

  it("does not route for a provider without a fast tier", async () => {
    const r = await resolveTurnModelAsync({
      provider: "ollama",
      currentModel: "llama3.2",
      text: "what is a closure?",
      enabled: true,
    });
    expect(r.routed).toBe(false);
  });
});
