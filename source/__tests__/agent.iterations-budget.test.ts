import { describe, it, expect, vi } from "vitest";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";
import { ToolRegistry } from "../tools/registry.js";
import { createSubagentTool } from "../tools/subagent.js";
import { createSkillTool } from "../skills/tool.js";
import { executeNativeAgent } from "../agents/executor.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";

vi.mock("../skills/loader.js", () => ({ getSkill: () => ({ name: "budget", slug: "budget", description: "test", body: "inspect", frontmatter: {}, origin: "project", filePath: "" }) }));
vi.mock("../skills/improvement.js", () => ({ recordSkillTrace: async () => {} }));

const config: AgavConfig = { provider: "ollama", model: "mock", effort: "low", permissionMode: "auto-accept", maxIterations: 3, maxTokens: 1000, errorRetries: 0 };
function makeProvider(reply: (params: StreamParams) => StreamEvent[]) {
  return { name: "mock", stream: vi.fn((params: StreamParams) => (async function* () {
    await Promise.resolve(); // Interleave concurrent requests after reservation.
    for (const event of reply(params)) yield event;
  })()) } satisfies LLMProvider;
}
async function collect(loop: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of loop) events.push(event);
  return events;
}
function run(provider: LLMProvider, budget: { remaining: number; total: number }, registry = new ToolRegistry(), conversation = new ConversationState()) {
  return collect(runAgentLoop({ provider, conversation, toolRegistry: registry, model: "mock", systemPrompt: "parent", permissionMode: "auto-accept", iterationsBudget: budget }));
}

describe("iterations budget behavior", () => {
  it("awaits complete continuations and makes zero requests after exact exhaustion", async () => {
    const budget = { remaining: 2, total: 2 };
    const provider = makeProvider(() => [{ type: "text_delta", text: "done" }]);
    const conversation = new ConversationState();
    conversation.addUserMessage("inspect");
    for (const remaining of [1, 0]) {
      expect((await run(provider, budget, undefined, conversation)).at(-1)).toEqual({ type: "turn_complete" });
      expect(budget.remaining).toBe(remaining);
      expect(provider.stream).toHaveBeenCalledTimes(2 - remaining);
      conversation.addInternalUserMessage("continue");
    }
    for (let retry = 0; retry < 2; retry++) {
      expect((await run(provider, budget, undefined, conversation)).at(-1)).toMatchObject({ type: "error", reason: "iterations_exhausted" });
      expect(provider.stream).toHaveBeenCalledTimes(2);
      expect(budget.remaining).toBe(0);
    }
  });

  it.each(["subagent", "skill"] as const)("shares exact parent consumption through actual %s tool delegation", async (kind) => {
    const budget = { remaining: 2, total: 2 };
    const toolName = kind === "subagent" ? "subagent" : "activate_skill";
    const provider = makeProvider(params => params.systemPrompt === "parent" ? [
      { type: "tool_call_start", toolCallId: "delegate", toolName },
      { type: "tool_call_delta", toolCallId: "delegate", argsJson: kind === "subagent" ? '{"title":"Inspect","task":"inspect"}' : '{"name":"budget"}' },
    ] : [{ type: "text_delta", text: "child done" }]);
    const registry = new ToolRegistry();
    const getConfig = () => ({ ...config, systemPrompt: "parent", iterationsBudget: budget });
    const tool = kind === "subagent" ? createSubagentTool({
      provider, parentToolRegistry: registry, getConfig, confirmationQueue: new ConfirmationQueue(),
      onProgressUpdate: () => {}, onTokenUsage: () => {}, getSignal: () => undefined,
    }) : createSkillTool({ provider, parentRegistry: registry, getConfig, getSignal: () => undefined });
    registry.register(tool);
    const events = await run(provider, budget, registry);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", output: "child done", isError: false }));
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "iterations_exhausted" });
    await run(provider, budget, registry);
    expect(provider.stream).toHaveBeenCalledTimes(2);
  });

  it("bounds concurrent real subagent and skill delegation to one aggregate allowance", async () => {
    const budget = { remaining: 3, total: 3 };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    const provider: LLMProvider & { stream: ReturnType<typeof vi.fn> } = {
      name: "mock", stream: vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> {
        if (++entered === 3) release();
        await gate;
        yield { type: "text_delta", text: "done" };
      })()),
    };
    const registry = new ToolRegistry();
    const getConfig = () => ({ ...config, systemPrompt: "parent", iterationsBudget: budget });
    const subagent = createSubagentTool({ provider, parentToolRegistry: registry, getConfig,
      confirmationQueue: new ConfirmationQueue(), onProgressUpdate: () => {}, onTokenUsage: () => {}, getSignal: () => undefined });
    const skill = createSkillTool({ provider, parentRegistry: registry, getConfig, getSignal: () => undefined });
    const results = await Promise.all([
      subagent.execute({ title: "One", task: "inspect one" }),
      subagent.execute({ title: "Two", task: "inspect two" }),
      skill.execute({ name: "budget" }), skill.execute({ name: "budget" }),
    ]);
    expect(results.filter(result => !result.isError)).toHaveLength(3);
    expect(provider.stream).toHaveBeenCalledTimes(3);
    expect(budget.remaining).toBe(0);
    expect((await subagent.execute({ title: "Exhausted", task: "inspect" })).isError).toBe(true);
    expect((await skill.execute({ name: "budget" })).isError).toBe(true);
    expect(provider.stream).toHaveBeenCalledTimes(3);
  });

  // Native tool wiring is tracked in #415 / PR #463. This exercises the real
  // executor's explicit shared-budget contract without copying that fix here.
  it("respects an explicitly supplied allowance for concurrent native executions", async () => {
    const budget = { remaining: 2, total: 2 };
    const provider = makeProvider(() => [{ type: "text_delta", text: "done" }]);
    const native = { manifest: { name: "budget", description: "test", version: "1" }, systemPrompt: "native", tools: [], origin: "project" as const, path: "/unused" };
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => executeNativeAgent(native, "inspect", { provider, config, iterationsBudget: budget })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(0);
    await expect(executeNativeAgent(native, "inspect", { provider, config, iterationsBudget: budget })).rejects.toThrow("maximum iterations");
    expect(provider.stream).toHaveBeenCalledTimes(2);
  });

  it("throws when iterationsBudget is missing", async () => {
    const provider = { stream: async function* () {} } as any;
    const conversation = { getMessages: () => [], setContextWindow: () => {}, compactIfNeeded: async () => ({ compacted: false }), addInternalUserMessage: () => {} } as any;
    const toolRegistry = { getSchemas: () => [] } as any;

    await expect(async () => {
      const loop = runAgentLoop({
        provider,
        conversation,
        toolRegistry,
        model: "m",
        systemPrompt: "",
        effort: "medium",
        maxTokens: 100,
        signal: new AbortController().signal,
        confirmTool: async () => ({ action: "allow" }),
        permissionMode: "ask",
      } as any);
      for await (const _ of loop) break;
    }).rejects.toThrow("iterationsBudget is required");
  });

  it("pre-reserves budget before async work", async () => {
    const budget = { remaining: 1, total: 1 };
    const provider = makeProvider(() => [{ type: "text_delta", text: "x" }]);
    const conversation = new ConversationState();
    const toolRegistry = new ToolRegistry();

    const loop = runAgentLoop({
      provider,
      conversation,
      toolRegistry,
      model: "m",
      systemPrompt: "",
      effort: "medium",
      maxTokens: 100,
      iterationsBudget: budget,
      signal: new AbortController().signal,
      confirmTool: async () => "yes",
      permissionMode: "ask",
    });

    // Budget should be decremented immediately on loop start, not after work
    // The first iteration decrements synchronously before the first await inside the loop body
    // Consume first yielded value to ensure loop has started
    const iterator = loop[Symbol.asyncIterator]();
    // Trigger start
    await iterator.next();
    // Budget already decremented; still await the complete execution.
    expect(budget.remaining).toBe(0);
    while (!(await iterator.next()).done) {}
  });
});
