import { EventEmitter } from "node:events";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConversationState } from "../agent/conversation.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";
import { runAgentLoop } from "../agent/loop.js";
import { agentToTool } from "../agents/registry-factory.js";
import type { AgentDefinition } from "../agents/types.js";
import type { AgavConfig } from "../config/config.js";
import { useAgent } from "../hooks/use-agent.js";
import render from "../ink/render.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import { executeSkill } from "../skills/executor.js";
import type { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { createSubagentTool } from "../tools/subagent.js";

vi.mock("../config/history.js", () => ({ saveSession: vi.fn() }));
vi.mock("../config/session-state.js", () => ({ saveSessionState: vi.fn() }));
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../agents/loader.js", () => ({ loadAgents: async () => [], getCachedAgents: vi.fn(() => []), setCachedAgents: vi.fn() }));
vi.mock("../utils/system-prompt.js", () => ({ refreshStableContext: async () => "", refreshVolatileContext: async () => ({ context: "" }), formatTurnContext: () => "" }));
vi.mock("../agent/planner.js", () => ({ shouldAutoPlan: () => false, savePlan: vi.fn(), loadPlan: async () => null, clearPlan: vi.fn(), isPlanActive: () => false, setPlanScope: vi.fn(), adoptPlanScope: vi.fn(), prunePlans: async () => {}, formatPlanForPrompt: () => "", ensurePlanFile: async () => {} }));

const config = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 1000, maxIterations: 5, errorRetries: 0, permissionMode: "auto-accept" } satisfies AgavConfig;
const native: AgentDefinition = {
  manifest: { name: "budget_regression", description: "Test agent", version: "1.0.0" },
  systemPrompt: "native", tools: [], origin: "project", path: "/unused/budget-regression",
};
const delegation: StreamEvent[] = [
  { type: "tool_call_start", toolCallId: "delegate", toolName: "budget_regression_agent" },
  { type: "tool_call_delta", toolCallId: "delegate", argsJson: '{"task":"inspect"}' },
];
function makeProvider(reply: (params: StreamParams) => StreamEvent[]) {
  const stream = vi.fn((params: StreamParams) => (async function* () {
    // Force concurrent loops to interleave after reserving their budget.
    await Promise.resolve();
    for (const event of reply(params)) yield event;
  })());
  return { name: "mock", stream } satisfies LLMProvider;
}
async function runParent(provider: LLMProvider, registry: ToolRegistry, budget: { remaining: number; total: number }) {
  const conversation = new ConversationState();
  conversation.addUserMessage("inspect");
  const events = [];
  for await (const event of runAgentLoop({ provider, conversation, toolRegistry: registry, model: "mock", systemPrompt: "parent", permissionMode: "auto-accept", iterationsBudget: budget })) events.push(event);
  return events;
}

describe("tool-invoked native agent iteration budgets", () => {
  it("spends the parent's exact budget rather than replenishing it", async () => {
    const budget = { remaining: 2, total: 2 };
    const provider = makeProvider(params => params.systemPrompt === "parent" ? delegation : [{ type: "text_delta", text: "done" }]);
    const registry = new ToolRegistry();
    registry.register(agentToTool(native, { provider, config, getIterationsBudget: () => budget }));
    await runParent(provider, registry, budget);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(0);
  });

  it("makes zero native provider requests when the parent exhausted the allowance", async () => {
    const budget = { remaining: 1, total: 1 };
    const provider = makeProvider(params => params.systemPrompt === "parent" ? delegation : [{ type: "text_delta", text: "done" }]);
    const registry = new ToolRegistry();
    registry.register(agentToTool(native, { provider, config, getIterationsBudget: () => budget }));
    const events = await runParent(provider, registry, budget);
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", isError: true, output: expect.stringContaining("maximum iterations") }));
  });

  it("cannot replenish the allowance through nested native-agent tools", async () => {
    const budget = { remaining: 2, total: 2 };
    const provider = makeProvider(() => delegation);
    const onProgressUpdate = vi.fn();
    const nested = agentToTool(native, { provider, config, getIterationsBudget: () => budget, onProgressUpdate });
    const outer = agentToTool({ ...native, tools: [nested] }, {
      provider, config, getIterationsBudget: () => budget, confirmTool: async () => "yes",
    });
    const result = await outer.execute({ task: "inspect" });
    expect(onProgressUpdate).toHaveBeenCalled(); // The nested executor actually ran.
    expect(result.isError).toBe(true);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(0);
  });

  it("bounds concurrent delegation to the aggregate allowance", async () => {
    const budget = { remaining: 2, total: 2 };
    const provider = makeProvider(() => [{ type: "text_delta", text: "done" }]);
    const tool = agentToTool(native, { provider, config, getIterationsBudget: () => budget });
    const results = await Promise.all(Array.from({ length: 5 }, () => tool.execute({ task: "inspect" })));
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(results.filter(result => !result.isError)).toHaveLength(2);
    expect(budget.remaining).toBe(0);
  });

  it("reads the live budget for each invocation, including independent prompts", async () => {
    let budget = { remaining: 0, total: 1 };
    const provider = makeProvider(() => [{ type: "text_delta", text: "done" }]);
    const tool = agentToTool(native, { provider, config, getIterationsBudget: () => budget });
    expect((await tool.execute({ task: "inspect" })).isError).toBe(true);
    expect(provider.stream).toHaveBeenCalledTimes(0);
    const previous = budget;
    budget = { remaining: 1, total: 1 };
    expect(await tool.execute({ task: "inspect" })).toEqual({ output: "done", isError: false });
    expect(provider.stream).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(0);
    expect(previous.remaining).toBe(0);
  });

  it.each(["subagent", "skill"] as const)("shares the budget when delegation originates in a %s", async (caller) => {
    const budget = { remaining: 2, total: 2 };
    const provider = makeProvider(params => params.systemPrompt === "native" ? [{ type: "text_delta", text: "done" }] : delegation);
    const registry = new ToolRegistry();
    registry.register(agentToTool(native, { provider, config, getIterationsBudget: () => budget }));
    if (caller === "subagent") {
      await createSubagentTool({
        provider, parentToolRegistry: registry,
        getConfig: () => ({ ...config, systemPrompt: "parent", iterationsBudget: budget }),
        confirmationQueue: new ConfirmationQueue(), onProgressUpdate: () => {}, onTokenUsage: () => {}, getSignal: () => undefined,
      }).execute({ title: "Inspect", task: "inspect" });
    } else {
      const skill: SkillDefinition = { name: "test", slug: "test", description: "test", frontmatter: { name: "test", description: "test" }, origin: "bundled", filePath: "", body: "inspect" };
      await executeSkill(skill, "", { provider, parentRegistry: registry, model: config.model, systemPrompt: "parent", permissionMode: "auto-accept", effort: "low", iterationsBudget: budget }).catch(error => {
        expect(error.message).toContain("maximum iterations");
      });
    }
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(0);
  });

  it("wires the live budget through real useAgent registration across user submissions", async () => {
    const { getCachedAgents } = await import("../agents/loader.js");
    vi.mocked(getCachedAgents).mockReturnValue([native]);
    const provider = makeProvider(params => params.systemPrompt === "native" ? [{ type: "text_delta", text: "done" }] : delegation);
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
    let agent: ReturnType<typeof useAgent>;
    function App() { agent = useAgent(provider, { ...config, maxIterations: 2 }); return null; }
    const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    try {
      await instance.waitUntilRenderFlush();
      for (const calls of [2, 4]) {
        await agent!.submit("inspect");
        await vi.waitFor(() => expect(provider.stream.mock.calls.length).toBeGreaterThanOrEqual(calls));
        await vi.waitFor(() => expect(agent!.isLoading).toBe(false));
        expect(provider.stream).toHaveBeenCalledTimes(calls);
        expect(agent!.iterationsBudget).toEqual({ remaining: 0, total: 2 });
      }
    } finally { instance.unmount(); vi.mocked(getCachedAgents).mockReturnValue([]); }
  });
});
