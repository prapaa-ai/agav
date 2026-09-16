import { describe, it, expect, beforeEach, vi } from "vitest";
import { runInteractiveKeySetup } from "../config/key-wizard.js";
import { assignKeysToConfig, type AgavConfig } from "../config/config.js";
import type * as readline from "node:readline/promises";

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    saveConfig: vi.fn().mockResolvedValue(undefined),
  };
});

function createMockReadline(answers: string[]) {
  let index = 0;
  return {
    question: vi.fn(async (_prompt: string) => {
      const answer = answers[index++] ?? "";
      return answer;
    }),
    close: vi.fn(),
  } as unknown as readline.Interface;
}

describe("Key Setup Wizard & Key Assignment", () => {
  let config: AgavConfig;

  beforeEach(() => {
    config = {
      provider: "nvidia",
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      effort: "high",
      maxTokens: 4096,
      maxIterations: 100,
      errorRetries: 3,
      permissionMode: "ask",
    };
  });

  describe("assignKeysToConfig", () => {
    it("assigns single and multiple keys for nvidia", () => {
      assignKeysToConfig(config, "nvidia", ["nvapi-key1", "nvapi-key2"], false);
      expect(config.nvidiaApiKey).toBe("nvapi-key1");
      expect(config.nvidiaApiKeys).toEqual(["nvapi-key1", "nvapi-key2"]);
    });

    it("assigns keys for groq", () => {
      assignKeysToConfig(config, "groq", ["gsk_key1", "gsk_key2"], false);
      expect(config.groqApiKey).toBe("gsk_key1");
      expect(config.groqApiKeys).toEqual(["gsk_key1", "gsk_key2"]);
    });

    it("assigns keys for gemini", () => {
      assignKeysToConfig(config, "gemini", ["gemini-key1"], false);
      expect(config.geminiApiKey).toBe("gemini-key1");
      expect(config.geminiApiKeys).toEqual(["gemini-key1"]);
    });

    it("assigns keys for openrouter, deepseek, openai, and anthropic", () => {
      assignKeysToConfig(config, "openrouter", ["sk-or-1"], false);
      expect(config.openrouterApiKey).toBe("sk-or-1");
      expect(config.openrouterApiKeys).toEqual(["sk-or-1"]);

      assignKeysToConfig(config, "deepseek", ["sk-ds-1"], false);
      expect(config.deepseekApiKey).toBe("sk-ds-1");
      expect(config.deepseekApiKeys).toEqual(["sk-ds-1"]);

      assignKeysToConfig(config, "openai", ["sk-oa-1"], false);
      expect(config.openaiApiKey).toBe("sk-oa-1");
      expect(config.openaiApiKeys).toEqual(["sk-oa-1"]);

      assignKeysToConfig(config, "anthropic", ["sk-ant-1"], false);
      expect(config.anthropicApiKey).toBe("sk-ant-1");
      expect(config.anthropicApiKeys).toEqual(["sk-ant-1"]);
    });

    it("appends and deduplicates keys when append is true", () => {
      assignKeysToConfig(config, "nvidia", ["nvapi-key1"], false);
      assignKeysToConfig(config, "nvidia", ["nvapi-key2", "nvapi-key1"], true);
      expect(config.nvidiaApiKey).toBe("nvapi-key1");
      expect(config.nvidiaApiKeys).toEqual(["nvapi-key1", "nvapi-key2"]);
    });

    it("overwrites existing keys when append is false", () => {
      assignKeysToConfig(config, "groq", ["gsk_old1", "gsk_old2"], false);
      assignKeysToConfig(config, "groq", ["gsk_new1"], false);
      expect(config.groqApiKey).toBe("gsk_new1");
      expect(config.groqApiKeys).toEqual(["gsk_new1"]);
    });
  });

  describe("runInteractiveKeySetup", () => {
    it("returns unconfigured if non-interactive and no customRl", async () => {
      const origIsTTY = process.stdin.isTTY;
      try {
        (process.stdin as any).isTTY = false;
        const result = await runInteractiveKeySetup(config);
        expect(result.configured).toBe(false);
      } finally {
        (process.stdin as any).isTTY = origIsTTY;
      }
    });

    it("handles option [1]: entering multiple keys for default provider", async () => {
      const mockRl = createMockReadline(["1", "nvapi-alpha, nvapi-beta"]);
      const result = await runInteractiveKeySetup(config, undefined, mockRl);

      expect(result.configured).toBe(true);
      expect(result.provider).toBe("nvidia");
      expect(result.keysAdded).toBe(2);
      expect(config.nvidiaApiKey).toBe("nvapi-alpha");
      expect(config.nvidiaApiKeys).toEqual(["nvapi-alpha", "nvapi-beta"]);
    });

    it("handles option [2]: switching provider to groq and entering keys", async () => {
      const mockRl = createMockReadline(["2", "groq", "gsk_groq1, gsk_groq2, gsk_groq3"]);
      const result = await runInteractiveKeySetup(config, undefined, mockRl);

      expect(result.configured).toBe(true);
      expect(result.provider).toBe("groq");
      expect(result.keysAdded).toBe(3);
      expect(config.provider).toBe("groq");
      expect(config.groqApiKey).toBe("gsk_groq1");
      expect(config.groqApiKeys).toEqual(["gsk_groq1", "gsk_groq2", "gsk_groq3"]);
    });

    it("handles option [2]: switching provider to ollama directly", async () => {
      const mockRl = createMockReadline(["2", "ollama"]);
      const result = await runInteractiveKeySetup(config, undefined, mockRl);

      expect(result.configured).toBe(true);
      expect(result.provider).toBe("ollama");
      expect(config.provider).toBe("ollama");
    });

    it("handles option [3]: selecting local ollama (zero keys needed)", async () => {
      const mockRl = createMockReadline(["3"]);
      const result = await runInteractiveKeySetup(config, undefined, mockRl);

      expect(result.configured).toBe(true);
      expect(result.provider).toBe("ollama");
      expect(config.provider).toBe("ollama");
    });

    it("handles option [4]: user chooses to exit", async () => {
      const mockRl = createMockReadline(["4"]);
      const result = await runInteractiveKeySetup(config, undefined, mockRl);

      expect(result.configured).toBe(false);
    });

    it("handles empty key submission gracefully", async () => {
      const mockRl = createMockReadline(["1", "   "]);
      const result = await runInteractiveKeySetup(config, undefined, mockRl);

      expect(result.configured).toBe(false);
    });

    it("handles forced provider override", async () => {
      const mockRl = createMockReadline(["1", "sk-ant-testkey"]);
      const result = await runInteractiveKeySetup(config, "anthropic", mockRl);

      expect(result.configured).toBe(true);
      expect(result.provider).toBe("anthropic");
      expect(result.keysAdded).toBe(1);
      expect(config.anthropicApiKey).toBe("sk-ant-testkey");
    });
  });
});
