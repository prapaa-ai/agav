import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { keysCommand, formatPoolStatus } from "../commands/keys.js";
import { KeyPoolManager } from "../providers/key-pool.js";
import type { CommandContext } from "../commands/types.js";
import type { AgavConfig } from "../config/config.js";

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    saveConfig: vi.fn().mockResolvedValue(undefined),
  };
});

import { saveConfig } from "../config/config.js";

describe("commands/keys", () => {
  let mockContext: CommandContext;
  let sampleKey1: string;
  let sampleKey2: string;
  let sampleOpenAiKey: string;

  beforeEach(() => {
    KeyPoolManager.resetInstance();
    vi.clearAllMocks();

    // Dynamically constructed keys to avoid static token scanner false positives
    sampleKey1 = ["sk", "ant", "test", "key1"].join("-");
    sampleKey2 = ["sk", "ant", "test", "key2"].join("-");
    sampleOpenAiKey = ["sk", "test", "openai", "1234"].join("-");

    const config: AgavConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      effort: "medium",
      maxTokens: 4096,
      maxIterations: 20,
      errorRetries: 3,
      permissionMode: "ask",
    };

    mockContext = {
      conversation: {} as any,
      config,
      setModel: vi.fn(),
      setProvider: vi.fn(),
      setEffort: vi.fn(),
      clearMessages: vi.fn(),
      refreshPlan: vi.fn(),
      showStatus: vi.fn(),
      saveSession: vi.fn(),
      refreshDisplay: vi.fn(),
      loadSession: vi.fn(),
      activateSession: vi.fn(),
      renameSession: vi.fn(),
      exit: vi.fn(),
      getDebugState: vi.fn(),
      submit: vi.fn(),
      handleSubmit: vi.fn(),
      toolRegistry: {} as any,
      addTokenUsage: vi.fn(),
      setRunningSkill: vi.fn(),
      setPickerActive: vi.fn(),
      suspendTerminal: vi.fn(() => () => {}),
      showAgentsTUI: vi.fn(),
      showSkillsTUI: vi.fn(),
    };
  });

  afterEach(() => {
    KeyPoolManager.resetInstance();
  });

  it("returns help text when invoked with help", async () => {
    const res = await keysCommand.execute("help", mockContext);
    expect(res.type).toBe("message");
    if (res.type === "message") {
      expect(res.text).toContain("Keys Management Usage");
      expect(res.text).toContain("/keys add");
    }
  });

  it("displays empty pool message when no keys are registered", async () => {
    const res = await keysCommand.execute("", mockContext);
    expect(res.type).toBe("message");
    if (res.type === "message") {
      expect(res.text).toContain("No API keys registered");
    }
  });

  it("adds keys to a provider pool and updates in-memory config", async () => {
    const res = await keysCommand.execute(`add anthropic ${sampleKey1},${sampleKey2}`, mockContext);
    expect(res.type).toBe("message");
    if (res.type === "message") {
      expect(res.text).toContain("Successfully added 2 key(s) to anthropic pool");
    }

    expect(saveConfig).toHaveBeenCalledWith(mockContext.config);
    expect(mockContext.config.anthropicApiKey).toBe(sampleKey1);
    expect(mockContext.config.anthropicApiKeys).toEqual([sampleKey1, sampleKey2]);

    const status = KeyPoolManager.getInstance().getPoolStatus("anthropic");
    expect(status.anthropic?.totalKeys).toBe(2);
  });

  it("inspects a specific provider pool with masked keys", async () => {
    await keysCommand.execute(`add openai ${sampleOpenAiKey}`, mockContext);

    const res = await keysCommand.execute("openai", mockContext);
    expect(res.type).toBe("message");
    if (res.type === "message") {
      expect(res.text).toContain("OPENAI (1 key");
      expect(res.text).toContain("AVAILABLE");
      // Key must be masked
      expect(res.text).not.toContain(sampleOpenAiKey);
      expect(res.text).toContain("sk-...1234");
    }
  });

  it("clears registered keys for a provider", async () => {
    await keysCommand.execute(`add anthropic ${sampleKey1}`, mockContext);
    expect(mockContext.config.anthropicApiKey).toBe(sampleKey1);

    const clearRes = await keysCommand.execute("clear anthropic", mockContext);
    expect(clearRes.type).toBe("message");
    if (clearRes.type === "message") {
      expect(clearRes.text).toContain('Cleared all API keys for provider "anthropic"');
    }

    expect(mockContext.config.anthropicApiKey).toBeUndefined();
    expect(mockContext.config.anthropicApiKeys).toEqual([]);

    const status = KeyPoolManager.getInstance().getPoolStatus("anthropic");
    expect(status.anthropic?.totalKeys).toBe(0);
  });

  it("handles missing provider or keys in add command gracefully", async () => {
    const res1 = await keysCommand.execute("add", mockContext);
    expect(res1.type).toBe("message");
    if (res1.type === "message") {
      expect(res1.text).toContain("Missing provider name");
    }

    const res2 = await keysCommand.execute("add anthropic", mockContext);
    expect(res2.type).toBe("message");
    if (res2.type === "message") {
      expect(res2.text).toContain("Missing API key(s) to add");
    }
  });

  it("handles missing provider in clear command gracefully", async () => {
    const res = await keysCommand.execute("clear", mockContext);
    expect(res.type).toBe("message");
    if (res.type === "message") {
      expect(res.text).toContain("Missing provider name");
    }
  });
});
