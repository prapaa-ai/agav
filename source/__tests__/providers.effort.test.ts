import { describe, expect, it } from "vitest";
import {
  applyEffortPrompt,
  applyOllamaEffortPrompt,
  mapAnthropicEffort,
  mapGeminiThinkingBudget,
  mapOpenAIEffort,
} from "../providers/effort.js";

describe("providers/effort mapping", () => {
  describe("OpenAI effort mapping", () => {
    it("maps minimal to low (lowest supported tier)", () => {
      expect(mapOpenAIEffort("minimal")).toBe("low");
    });

    it("preserves existing mappings for all standard tiers", () => {
      expect(mapOpenAIEffort("low")).toBe("low");
      expect(mapOpenAIEffort("medium")).toBe("medium");
      expect(mapOpenAIEffort("high")).toBe("high");
      expect(mapOpenAIEffort("max")).toBe("xhigh");
    });
  });

  describe("Anthropic effort mapping", () => {
    it("maps minimal to low (lowest supported tier)", () => {
      expect(mapAnthropicEffort("minimal")).toBe("low");
    });

    it("preserves existing mappings for all standard tiers", () => {
      expect(mapAnthropicEffort("low")).toBe("low");
      expect(mapAnthropicEffort("medium")).toBe("medium");
      expect(mapAnthropicEffort("high")).toBe("high");
      expect(mapAnthropicEffort("max")).toBe("max");
    });
  });

  describe("Gemini thinking budget mapping", () => {
    it("maps minimal to 0 (lowest supported thinking budget)", () => {
      expect(mapGeminiThinkingBudget("minimal")).toBe(0);
    });

    it("preserves existing budgets for all standard tiers", () => {
      expect(mapGeminiThinkingBudget("low")).toBe(0);
      expect(mapGeminiThinkingBudget("medium")).toBe(1024);
      expect(mapGeminiThinkingBudget("high")).toBe(8192);
      expect(mapGeminiThinkingBudget("max")).toBe(24576);
    });
  });

  describe("applyEffortPrompt (prompt steering fallback)", () => {
    it("steers minimal with the concise guidance used for low", () => {
      const minimalPrompt = applyEffortPrompt("Base prompt", "minimal");
      const lowPrompt = applyEffortPrompt("Base prompt", "low");

      expect(minimalPrompt).toBe("Be concise. Answer directly. Skip analysis unless asked.\n\nBase prompt");
      expect(minimalPrompt).toBe(lowPrompt);
    });

    it("handles undefined system prompt for minimal", () => {
      expect(applyEffortPrompt(undefined, "minimal")).toBe(
        "Be concise. Answer directly. Skip analysis unless asked.",
      );
    });

    it("preserves existing prompts for standard tiers", () => {
      expect(applyEffortPrompt("Base", "medium")).toBe("Base");
      expect(applyEffortPrompt("Base", "high")).toBe(
        "Think carefully. Consider edge cases. Verify your reasoning.\n\nBase",
      );
      expect(applyEffortPrompt("Base", "max")).toBe(
        "Be exhaustive. Consider multiple approaches. Verify all claims.\n\nBase",
      );
    });
  });

  describe("applyOllamaEffortPrompt", () => {
    it("steers minimal with concise guidance matching low", () => {
      const minimalPrompt = applyOllamaEffortPrompt("Base prompt", "minimal");
      const lowPrompt = applyOllamaEffortPrompt("Base prompt", "low");

      expect(minimalPrompt).toBe("Be concise. Answer directly. Skip analysis unless asked.\n\nBase prompt");
      expect(minimalPrompt).toBe(lowPrompt);
    });

    it("preserves existing Ollama prompts for standard tiers", () => {
      expect(applyOllamaEffortPrompt("Base", "medium")).toBe("Base");
      expect(applyOllamaEffortPrompt("Base", "high")).toContain("Think carefully before answering");
      expect(applyOllamaEffortPrompt("Base", "max")).toContain("Use maximum reasoning effort");
    });
  });
});
