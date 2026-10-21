import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../commands/model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/model.js")>();
  return { ...actual, fetchAvailableModels: vi.fn() };
});
vi.mock("../agent/loop.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../providers/registry.js", () => ({ createProvider: vi.fn(() => ({ name: "child" })) }));
vi.mock("../utils/worktree.js", () => ({
  createWorktree: vi.fn(() => Promise.resolve(null)),
  removeWorktree: vi.fn(() => Promise.resolve()),
  applyWorktreeChanges: vi.fn(() => Promise.resolve({ applied: true })),
}));
vi.mock("../commands/steer.js", () => ({
  formatSteersForPrompt: vi.fn(() => ""),
  createSteerQueue: () => ({ drain: () => [], dispose: vi.fn() }),
}));

import { fetchAvailableModels } from "../commands/model.js";
import { runAgentLoop } from "../agent/loop.js";
import { createProvider } from "../providers/registry.js";
import { createSubagentTool } from "../tools/subagent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { FetchedModel } from "../commands/model.js";

function makeTool(models: FetchedModel[], provider = "openai") {
  vi.mocked(fetchAvailableModels).mockResolvedValue({ models, warnings: [] });
  vi.mocked(runAgentLoop).mockImplementation(() => (async function* () {
    yield { type: "assistant_message_complete" as const, text: "finished" };
  })() as any);

  const providerConfig = {
    provider,
    model: "active-model",
    openrouterApiKey: "router-key",
    vertexAICredentialsPath: "/tmp/vertex.json",
    vertexAILocation: "us-east5",
    effort: "medium" as const,
    maxTokens: 1000,
    maxIterations: 2,
    errorRetries: 0,
    permissionMode: "auto-accept" as const,
  };
  const tool = createSubagentTool({
    provider: { name: "parent" } as any,
    parentToolRegistry: new ToolRegistry(),
    getConfig: () => ({
      model: "active-model",
      systemPrompt: "test prompt",
      permissionMode: "auto-accept",
      effort: "medium",
      iterationsBudget: { remaining: 2, total: 2 },
    }),
    getProviderConfig: () => providerConfig as any,
    confirmationQueue: {
      enqueue: vi.fn(() => Promise.resolve("yes")),
      rejectBySubagentId: vi.fn(),
    } as any,
    onProgressUpdate: vi.fn(),
    onTokenUsage: vi.fn(),
    getSignal: () => undefined,
  });
  return { tool, providerConfig };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

async function spawn(tool: ReturnType<typeof createSubagentTool>, model: string) {
  const result = await tool.execute({ title: "test", task: "inspect the behavior", model });
  await vi.advanceTimersByTimeAsync(100);
  expect(result, String(result.output)).toMatchObject({ isError: false });
  return vi.mocked(runAgentLoop).mock.calls.at(-1)![0];
}

describe("subagent model selection", () => {
  it("resolves a bare Vertex model and uses its canonical ID and provider", async () => {
    const { tool, providerConfig } = makeTool([
      { id: "vertex/gemini-3.6-flash", provider: "vertex-ai", contextWindow: 256_000 },
    ]);

    const loopParams = await spawn(tool, "gemini-3.6-flash");

    expect(vi.mocked(createProvider)).toHaveBeenCalledWith({
      ...providerConfig,
      provider: "vertex-ai",
      model: "vertex/gemini-3.6-flash",
    });
    expect(loopParams.model).toBe("vertex/gemini-3.6-flash");
    expect(loopParams.conversation.getContextWindow()).toBe(256_000);
  });

  it("resolves bare OpenRouter names, selecting the active provider among matches", async () => {
    const { tool, providerConfig } = makeTool([
      { id: "anthropic/claude-sonnet", provider: "openrouter", contextWindow: 128_000 },
      { id: "claude-sonnet", provider: "anthropic", contextWindow: 200_000 },
    ], "openrouter");

    const loopParams = await spawn(tool, "claude-sonnet");

    expect(vi.mocked(createProvider)).toHaveBeenCalledWith({
      ...providerConfig,
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
    });
    expect(loopParams.model).toBe("anthropic/claude-sonnet");
    expect(loopParams.conversation.getContextWindow()).toBe(128_000);
  });

  it("rejects a subagent model that violates the parent org allowlist", async () => {
    const { tool } = makeTool([
      { id: "gpt-4o", provider: "openai" },
    ], "openai");
    // Parent policy allows only gpt-5.4; requesting gpt-4o must be refused.
    const providerConfig = (tool as any);
    void providerConfig;
    vi.mocked(fetchAvailableModels).mockResolvedValue({
      models: [{ id: "gpt-4o", provider: "openai" }],
      warnings: [],
    });

    // Rebuild a tool whose provider config carries the allowlist.
    const policedTool = createSubagentTool({
      provider: { name: "parent" } as any,
      parentToolRegistry: new ToolRegistry(),
      getConfig: () => ({
        model: "gpt-5.4",
        systemPrompt: "test prompt",
        permissionMode: "auto-accept",
        effort: "medium",
        iterationsBudget: { remaining: 2, total: 2 },
      }),
      getProviderConfig: () => ({
        provider: "openai",
        model: "gpt-5.4",
        openaiApiKey: "k",
        effort: "medium",
        maxTokens: 1000,
        maxIterations: 2,
        errorRetries: 0,
        permissionMode: "auto-accept",
        orgAllowedModels: ["gpt-5.4"],
      }) as any,
      confirmationQueue: { enqueue: vi.fn(() => Promise.resolve("yes")), rejectBySubagentId: vi.fn() } as any,
      onProgressUpdate: vi.fn(),
      onTokenUsage: vi.fn(),
      getSignal: () => undefined,
    });

    const result = await policedTool.execute({ title: "test", task: "inspect", model: "gpt-4o" });
    await vi.advanceTimersByTimeAsync(100);
    expect(result.isError).toBe(true);
    expect(String(result.output)).toMatch(/not permitted by your organization/);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it("reuses a model catalog for multiple different-model spawns with unchanged config", async () => {
    const { tool } = makeTool([
      { id: "router/model-one", provider: "openrouter" },
      { id: "router/model-two", provider: "openrouter" },
    ], "openrouter");

    await spawn(tool, "model-one");
    await spawn(tool, "model-two");

    expect(fetchAvailableModels).toHaveBeenCalledTimes(1);
  });
});
