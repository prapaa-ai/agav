import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runInteractiveKeySetup, type KeyWizardIO } from "../config/key-wizard.js";
import { KeyPoolManager } from "../providers/key-pool.js";
import type { AgavConfig } from "../config/config.js";

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    saveConfig: vi.fn().mockResolvedValue(undefined),
  };
});

import { saveConfig } from "../config/config.js";

describe("config/key-wizard", () => {
  let sampleAnthropicKey: string;
  let sampleOpenAiKey1: string;
  let sampleOpenAiKey2: string;
  let baseConfig: AgavConfig;

  beforeEach(() => {
    KeyPoolManager.resetInstance();
    vi.clearAllMocks();

    sampleAnthropicKey = ["sk", "ant", "test", "key1234"].join("-");
    sampleOpenAiKey1 = ["sk", "test", "open", "key1"].join("-");
    sampleOpenAiKey2 = ["sk", "test", "open", "key2"].join("-");

    baseConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      effort: "medium",
      maxTokens: 4096,
      maxIterations: 20,
      errorRetries: 3,
      permissionMode: "ask",
    };
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
  });

  it("guides user through provider selection and key registration", async () => {
    const writtenMessages: string[] = [];
    const mockIO: KeyWizardIO = {
      prompt: vi
        .fn()
        .mockResolvedValueOnce("1") // Anthropic choice
        .mockResolvedValueOnce(sampleAnthropicKey),
      write: (msg) => writtenMessages.push(msg),
    };

    const updated = await runInteractiveKeySetup(baseConfig, undefined, mockIO);

    expect(updated).not.toBeNull();
    expect(updated?.provider).toBe("anthropic");
    expect(updated?.anthropicApiKey).toBe(sampleAnthropicKey);
    expect(updated?.anthropicApiKeys).toEqual([sampleAnthropicKey]);

    expect(saveConfig).toHaveBeenCalledWith(updated);

    const status = KeyPoolManager.getInstance().getPoolStatus("anthropic");
    expect(status.anthropic?.totalKeys).toBe(1);
    expect(writtenMessages.some((m) => m.includes("Encrypted credentials saved"))).toBe(true);
  });

  it("handles multi-key input for key rotation pooling", async () => {
    const mockIO: KeyWizardIO = {
      prompt: vi
        .fn()
        .mockResolvedValueOnce("2") // OpenAI
        .mockResolvedValueOnce(`${sampleOpenAiKey1}, ${sampleOpenAiKey2}`),
      write: vi.fn(),
    };

    const updated = await runInteractiveKeySetup(baseConfig, undefined, mockIO);

    expect(updated).not.toBeNull();
    expect(updated?.provider).toBe("openai");
    expect(updated?.openaiApiKey).toBe(sampleOpenAiKey1);
    expect(updated?.openaiApiKeys).toEqual([sampleOpenAiKey1, sampleOpenAiKey2]);

    const status = KeyPoolManager.getInstance().getPoolStatus("openai");
    expect(status.openai?.totalKeys).toBe(2);
  });

  it("skips provider selection if targetProvider is explicitly supplied", async () => {
    const mockIO: KeyWizardIO = {
      prompt: vi.fn().mockResolvedValueOnce(sampleAnthropicKey),
      write: vi.fn(),
    };

    const updated = await runInteractiveKeySetup(baseConfig, "anthropic", mockIO);

    expect(mockIO.prompt).toHaveBeenCalledTimes(1);
    expect(updated?.provider).toBe("anthropic");
    expect(updated?.anthropicApiKey).toBe(sampleAnthropicKey);
  });

  it("aborts cleanly when user enters an empty key", async () => {
    const mockIO: KeyWizardIO = {
      prompt: vi
        .fn()
        .mockResolvedValueOnce("1")
        .mockResolvedValueOnce("   "),
      write: vi.fn(),
    };

    const updated = await runInteractiveKeySetup(baseConfig, undefined, mockIO);

    expect(updated).toBeNull();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("aborts cleanly when user enters an invalid choice", async () => {
    const mockIO: KeyWizardIO = {
      prompt: vi.fn().mockResolvedValueOnce("invalid_provider_xyz"),
      write: vi.fn(),
    };

    const updated = await runInteractiveKeySetup(baseConfig, undefined, mockIO);

    expect(updated).toBeNull();
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
