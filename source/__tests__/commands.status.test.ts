import { describe, expect, it, vi } from "vitest";
import { statusCommand } from "../commands/status.js";
import { contextCommand } from "../commands/context.js";
import type { CommandContext } from "../commands/types.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";
import { getSandboxName } from "../utils/sandbox.js";
import { estimateTokens } from "../utils/tokens.js";
import { terminalRelativePaths, _clearConfigCache } from "../utils/display-path.js";

// Match /context's boundaries so occupancy is deterministic: a fixed base
// system prompt and a single-skill catalog.
vi.mock("../utils/system-prompt.js", () => ({ buildSystemPrompt: async () => "baseline" }));
vi.mock("../skills/loader.js", () => ({ getCachedSkills: () => [{ name: "demo" }], buildSkillCatalog: () => "skill catalog" }));

const createContext = (overrides: Partial<CommandContext> = {}): CommandContext => {
  const conversation = new ConversationState();
  conversation.setModel("gpt-5.4-mini");
  const toolRegistry = new ToolRegistry();
  return {
    conversation,
    toolRegistry,
    config: {
      model: "gpt-5.4-mini",
      provider: "openai",
      effort: "medium",
      permissionMode: "ask",
      systemPrompt: "custom prompt",
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
    addTokenUsage: vi.fn(),
    setRunningSkill: vi.fn(),
    setPickerActive: vi.fn(),
    suspendTerminal: vi.fn(() => vi.fn()),
    showAgentsTUI: vi.fn(),
    showSkillsTUI: vi.fn(),
    ...overrides,
  } as unknown as CommandContext;
};

async function statusText(context: CommandContext): Promise<string> {
  const result = await statusCommand.execute("", context);
  if (result.type !== "message") throw new Error("Expected message result");
  return result.text;
}

describe("commands/status", () => {
  it("exposes expected command metadata", () => {
    expect(statusCommand.name).toBe("status");
    expect(statusCommand.description).toBeTruthy();
    expect(statusCommand.usage).toContain("/status");
  });

  it("formats session status with all metrics matching Issue #382 specification", async () => {
    const context = createContext();
    const text = await statusText(context);

    expect(text).toContain("Session Status");
    expect(text).toContain("Model:        gpt-5.4-mini (openai)");
    expect(text).toContain("Effort:       medium");
    expect(text).toContain(`Permissions:  ask · ${getSandboxName()}`);
    expect(text).toContain(`Directory:    ${process.cwd()}`);
    expect(text).toContain("MCP servers:  2 connected");
  });

  it("preserves the absolute Directory through terminal path formatting (not collapsed to '.')", async () => {
    _clearConfigCache();
    const context = createContext();
    const result = await statusCommand.execute("", context);
    if (result.type !== "message") throw new Error("Expected message result");

    // The TUI collapses the working directory to "." for ordinary system
    // messages — which is exactly wrong for /status, whose purpose is to show
    // the absolute working directory. The command opts out via preservePaths.
    expect(result.preservePaths).toBe(true);

    // Sanity: without the opt-out, the formatter would rewrite the cwd to ".".
    const collapsed = terminalRelativePaths(result.text);
    expect(collapsed).toContain("Directory:    .");

    // With preservePaths honored (render path skips the formatter), the
    // absolute path survives verbatim.
    const rendered = result.preservePaths ? result.text : terminalRelativePaths(result.text);
    expect(rendered).toContain(`Directory:    ${process.cwd()}`);
    expect(rendered).not.toContain("Directory:    .");
  });

  it("counts the system prompt and skills in token usage, not just messages (#563)", async () => {
    const context = createContext();
    context.conversation.addUserMessage("hello there");

    // Occupancy = base system prompt + skill catalog + message tokens.
    const expected =
      estimateTokens("custom prompt") +
      estimateTokens("skill catalog") +
      context.conversation.tokenCount;

    const text = await statusText(context);
    expect(expected).toBeGreaterThan(context.conversation.tokenCount);
    expect(text).toContain(`Token usage:  ${fmtTokens(expected)} / 400.0k (${pct(expected, 400_000)})`);
  });

  it("reports the same used-token total as /context", async () => {
    const context = createContext();
    context.conversation.addUserMessage("a longer message to occupy some context window space");

    const status = await statusText(context);
    const ctxResult = await contextCommand.execute("", context);
    if (ctxResult.type !== "message") throw new Error("Expected message result");

    // Extract /status "Token usage:  <used> / ..." and /context "Used  <used> ...".
    const statusUsed = status.match(/Token usage:\s+(\S+) \//)?.[1];
    const contextUsed = ctxResult.text.match(/Used\s+(\S+)\s/)?.[1];
    expect(statusUsed).toBeTruthy();
    expect(statusUsed).toBe(contextUsed);
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

    const text = await statusText(context);
    expect(text).toContain("MCP servers:  0 connected");
  });

  it("reports the effective session permission mode, not the config default", async () => {
    // After an "Always" approval, the session widens to auto-accept while
    // config.permissionMode stays "ask". /status must show the live mode.
    const context = createContext({
      getEffectivePermissionMode: vi.fn(() => "auto-accept" as const),
    });

    const text = await statusText(context);
    expect(text).toContain(`Permissions:  auto-accept · ${getSandboxName()}`);
  });

  it("falls back to config.permissionMode when no effective mode is available", async () => {
    const context = createContext({
      config: { model: "gpt-5.4-mini", provider: "openai", effort: "medium", permissionMode: "deny-writes", systemPrompt: "custom prompt" } as any,
      getEffectivePermissionMode: undefined,
    });

    const text = await statusText(context);
    expect(text).toContain(`Permissions:  deny-writes · ${getSandboxName()}`);
  });

  it("respects explicit context window overrides and provider reporting", async () => {
    const context = createContext({
      config: { model: "custom-model", provider: "anthropic", effort: "high", permissionMode: "auto-accept", systemPrompt: "custom prompt" } as any,
    });
    context.conversation.setContextWindow(500_000);

    const text = await statusText(context);
    expect(text).toContain("Model:        custom-model (anthropic)");
    expect(text).toContain("Effort:       high");
    expect(text).toContain(`Permissions:  auto-accept · ${getSandboxName()}`);
    expect(text).toContain("/ 500.0k (");
  });
});

// Mirror the command's own formatting so expectations track any future change.
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
}
