import { describe, expect, it, vi } from "vitest";
import { statusCommand } from "../commands/status.js";
import type { CommandContext } from "../commands/types.js";
import { getSandboxName } from "../utils/sandbox.js";

const createContext = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  conversation: {
    tokenCount: 14_200,
    getContextWindow: vi.fn(() => undefined),
    getManualContextWindow: vi.fn(() => undefined),
    setContextWindow: vi.fn(),
  } as any,
  config: {
    model: "gpt-5.4-mini",
    provider: "openai",
    effort: "medium",
    permissionMode: "ask",
  } as any,
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
  getDebugState: vi.fn(() => ({
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    loadedPlugins: [],
    mcpServers: ["jira", "github"],
    mcpResources: 0,
    mcpPrompts: 0,
  })),
  submit: vi.fn(),
  handleSubmit: vi.fn(),
  toolRegistry: {} as any,
  addTokenUsage: vi.fn(),
  setRunningSkill: vi.fn(),
  setPickerActive: vi.fn(),
  suspendTerminal: vi.fn(() => vi.fn()),
  showAgentsTUI: vi.fn(),
  showSkillsTUI: vi.fn(),
  ...overrides,
});

describe("commands/status", () => {
  it("exposes expected command metadata", () => {
    expect(statusCommand.name).toBe("status");
    expect(statusCommand.description).toBeTruthy();
    expect(statusCommand.usage).toContain("/status");
  });

  it("formats session status with all metrics matching Issue #382 specification", async () => {
    const context = createContext();
    const result = await statusCommand.execute("", context);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("Expected message result");

    const text = result.text;
    expect(text).toContain("Session Status");
    expect(text).toContain("Model:        gpt-5.4-mini (openai)");
    expect(text).toContain("Effort:       medium");
    expect(text).toContain(`Permissions:  ask · ${getSandboxName()}`);
    expect(text).toContain(`Directory:    ${process.cwd()}`);
    expect(text).toContain("Token usage:  14.2k / 400.0k (3.5%)");
    expect(text).toContain("MCP servers:  2 connected");
  });

  it("handles zero MCP servers gracefully", async () => {
    const context = createContext({
      getDebugState: vi.fn(() => ({
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        loadedPlugins: [],
        mcpServers: [],
        mcpResources: 0,
        mcpPrompts: 0,
      })),
    });

    const result = await statusCommand.execute("", context);
    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("Expected message result");

    expect(result.text).toContain("MCP servers:  0 connected");
  });

  it("respects explicit context window overrides and provider reporting", async () => {
    const context = createContext({
      conversation: {
        tokenCount: 50_000,
        getContextWindow: vi.fn(() => 500_000),
        getManualContextWindow: vi.fn(() => undefined),
        setContextWindow: vi.fn(),
      } as any,
      config: {
        model: "custom-model",
        provider: "anthropic",
        effort: "high",
        permissionMode: "auto-accept",
      } as any,
    });

    const result = await statusCommand.execute("", context);
    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("Expected message result");

    expect(result.text).toContain("Model:        custom-model (anthropic)");
    expect(result.text).toContain("Effort:       high");
    expect(result.text).toContain(`Permissions:  auto-accept · ${getSandboxName()}`);
    expect(result.text).toContain("Token usage:  50.0k / 500.0k (10.0%)");
  });
});
