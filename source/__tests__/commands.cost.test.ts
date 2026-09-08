import { describe, expect, it, vi } from "vitest";

import { costCommand } from "../commands/cost.js";
import type { CommandContext, DebugState, TokenUsage } from "../commands/types.js";

function createContext(model: string, tokenUsage: TokenUsage): CommandContext {
  const debug: DebugState = {
    tokenUsage,
    loadedPlugins: [],
    mcpServers: [],
    mcpResources: 0,
    mcpPrompts: 0,
  };
  return {
    conversation: {} as any,
    config: { model } as any,
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
    getDebugState: () => debug,
    submit: vi.fn(),
    handleSubmit: vi.fn(),
    toolRegistry: {} as any,
    addTokenUsage: vi.fn(),
    setRunningSkill: vi.fn(),
    setPickerActive: vi.fn(),
    suspendTerminal: vi.fn(() => vi.fn()),
    showAgentsTUI: vi.fn(),
    showSkillsTUI: vi.fn(),
  };
}

const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...u,
});

describe("/cost command", () => {
  it("reports token counts and an estimated cost for a known model", async () => {
    const ctx = createContext(
      "claude-sonnet-4-20250514",
      usage({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 500_000 }),
    );
    const result = await costCommand.execute("", ctx);
    expect(result.type).toBe("message");
    const text = (result as { text: string }).text;
    expect(text).toContain("Session cost");
    expect(text).toContain("claude-sonnet-4-20250514");
    expect(text).toContain("Estimated cost");
    // Cache-read dominated → should report a saving line.
    expect(text).toContain("Prompt caching saved");
  });

  it("reports a cache hit rate", async () => {
    const ctx = createContext(
      "claude-sonnet-4-20250514",
      usage({ inputTokens: 100_000, cacheReadTokens: 300_000 }),
    );
    const text = ((await costCommand.execute("", ctx)) as { text: string }).text;
    // 300k / (100k + 300k) = 75%.
    expect(text).toContain("Cache hit rate (input side): 75%");
  });

  it("says estimate is unavailable for an unknown model", async () => {
    const ctx = createContext("some-local-llama", usage({ inputTokens: 1000 }));
    const text = ((await costCommand.execute("", ctx)) as { text: string }).text;
    expect(text).toContain("No price table entry");
    expect(text).not.toContain("Estimated cost");
  });
});
