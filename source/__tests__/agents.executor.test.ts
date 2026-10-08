import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../agent/loop.js";
import type { AgentDefinition } from "../agents/types.js";
import type { AgavConfig } from "../config/config.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

vi.mock("../agent/loop.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../agents/loader.js", () => ({ getCachedAgents: vi.fn(() => []) }));
vi.mock("../utils/encrypt.js", () => ({ decrypt: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: vi.fn().mockRejectedValue(new Error("No credentials")),
}));

import { runAgentLoop } from "../agent/loop.js";
import { executeNativeAgent } from "../agents/executor.js";
import { agentToTool } from "../agents/registry-factory.js";
import { executeTargetedAgent } from "../agents/targeting.js";

const agent: AgentDefinition = {
  manifest: { name: "demo", description: "Test agent", version: "1.0.0" },
  systemPrompt: "Do the task", tools: [], origin: "project", path: "/unused/demo",
};
const config = { model: "mock-model", effort: "low", maxTokens: 1000, maxIterations: 5 } as AgavConfig;
const provider: LLMProvider = { name: "mock", stream: vi.fn() };
const deps = { provider, config };

function setEvents(events: AgentEvent[], thrown?: Error) {
  vi.mocked(runAgentLoop).mockImplementation(() => (async function* () {
    for (const event of events) yield event;
    if (thrown) throw thrown;
  })());
}

beforeEach(() => { vi.clearAllMocks(); });

describe("named-agent final output", () => {
  it("returns only the last completed answer and forwards every progress event unchanged", async () => {
    const events: AgentEvent[] = [
      { type: "thinking", text: "Planning" },
      { type: "streaming_text", text: "Inspecting files" },
      { type: "tool_call_start", toolName: "inspect", toolCallId: "one" },
      { type: "tool_call_input_delta", toolCallId: "one", argsJson: "{}" },
      { type: "assistant_message_complete", text: "Inspecting files" },
      { type: "tool_result", toolName: "inspect", toolCallId: "one", output: "data", isError: false },
      { type: "streaming_text", text: "Checking results" },
      { type: "assistant_message_complete", text: "Checking results" },
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "streaming_text", text: "Final " },
      { type: "streaming_text", text: "answer" },
      { type: "assistant_message_complete", text: "Final answer" },
      { type: "turn_complete" },
    ];
    const onProgressUpdate = vi.fn(async (_callId: string, _event: AgentEvent) => {});
    vi.mocked(runAgentLoop).mockImplementation(() => (async function* () {
      for (const event of events) {
        yield event;
        expect(onProgressUpdate).toHaveBeenLastCalledWith(expect.any(String), event);
      }
    })());
    const budget = { remaining: 5, total: 5 };
    const signal = new AbortController().signal;
    const confirmTool = vi.fn(async () => "yes" as const);
    const hooks = { afterEdit: "check" };
    expect(await executeNativeAgent(agent, "task", {
      ...deps, onProgressUpdate, iterationsBudget: budget, signal, confirmTool, hooks,
    })).toBe("Final answer");
    expect(onProgressUpdate.mock.calls.map((call) => call[1])).toEqual([...events, { type: "turn_complete" }]);
    expect(new Set(onProgressUpdate.mock.calls.map((call) => call[0])).size).toBe(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      provider, model: config.model, effort: config.effort, maxTokens: config.maxTokens,
      iterationsBudget: budget, signal, confirmTool, hooks, permissionMode: "ask",
    }));
  });

  it("uses completed answers even without streaming and clears stale text on empty turns", async () => {
    setEvents([
      { type: "assistant_message_complete", text: "Intermediate" },
      { type: "assistant_message_complete", text: "" },
      { type: "assistant_message_complete", text: "Final without deltas" },
      { type: "turn_complete" },
    ]);
    expect(await executeNativeAgent(agent, "task", deps)).toBe("Final without deltas");
  });

  it.each([{ events: [] }, { events: [
    { type: "streaming_text", text: "Stale narration" },
    { type: "assistant_message_complete", text: "Stale narration" },
    { type: "tool_call_start", toolName: "inspect", toolCallId: "one" },
    { type: "assistant_message_complete", text: "" },
    { type: "tool_result", toolName: "inspect", toolCallId: "one", output: "data", isError: false },
    { type: "assistant_message_complete", text: "" },
    { type: "turn_complete" },
  ] satisfies AgentEvent[] }])("returns the no-output fallback for empty final answers (%#)", async ({ events }) => {
    setEvents(events);
    expect(await executeNativeAgent(agent, "task", deps)).toBe("Agent completed with no output.");
  });

  it.each([false, true])("rejects errors before output, without reporting successful progress (thrown=%s)", async (thrown) => {
    const error = new Error("provider failed");
    setEvents(thrown ? [] : [{ type: "error", error }], thrown ? error : undefined);
    const onProgressUpdate = vi.fn();
    await expect(executeNativeAgent(agent, "task", { ...deps, onProgressUpdate })).rejects.toBe(error);
    expect(onProgressUpdate.mock.calls.map((call) => call[1])).toEqual([{ type: "error", error }]);
  });

  it.each([false, true])("preserves completed and streamed partial work as incomplete on failure (thrown=%s)", async (thrown) => {
    const error = new Error("provider failed");
    const events: AgentEvent[] = [
      { type: "streaming_text", text: "Found a clue" },
      { type: "assistant_message_complete", text: "Found a clue" },
      { type: "streaming_text", text: "Unfinished " },
      { type: "streaming_text", text: "analysis" },
    ];
    setEvents(thrown ? events : [...events, { type: "error", error }], thrown ? error : undefined);
    const onProgressUpdate = vi.fn();
    await expect(executeNativeAgent(agent, "task", { ...deps, onProgressUpdate })).rejects.toThrow(
      "Agent work incomplete: provider failed\n\nPartial output (not a final answer):\nFound a clue\n\nUnfinished analysis",
    );
    expect(onProgressUpdate.mock.calls.map((call) => call[1])).toEqual([...events, { type: "error", error }]);
  });

  it("does not treat a stale completed answer as success when the next turn fails", async () => {
    setEvents([
      { type: "assistant_message_complete", text: "Still working" },
      { type: "error", error: new Error("Aborted") },
    ]);
    await expect(executeNativeAgent(agent, "task", deps)).rejects.toThrow(
      "Agent work incomplete: Aborted\n\nPartial output (not a final answer):\nStill working",
    );
  });

  it("detects cancellation even if the loop exits silently and preserves streamed work", async () => {
    const controller = new AbortController();
    vi.mocked(runAgentLoop).mockImplementation(() => (async function* () {
      yield { type: "streaming_text", text: "Partial work" };
      controller.abort();
    })());
    const onProgressUpdate = vi.fn();
    await expect(executeNativeAgent(agent, "task", { ...deps, signal: controller.signal, onProgressUpdate }))
      .rejects.toThrow("Agent work incomplete: Aborted\n\nPartial output (not a final answer):\nPartial work");
    expect(onProgressUpdate).toHaveBeenLastCalledWith(expect.any(String), { type: "error", error: new Error("Aborted") });
  });

  it("marks partial failures as errors for both tool and targeted callers", async () => {
    setEvents([
      { type: "streaming_text", text: "Useful partial" },
      { type: "error", error: new Error("provider failed") },
    ]);
    const results = await Promise.all([
      agentToTool(agent, deps).execute({ task: "task" }),
      executeTargetedAgent(agent, "task", deps),
    ]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Agent work incomplete: provider failed");
      expect(result.output).toContain("Partial output (not a final answer):\nUseful partial");
    }
  });

  it("keeps concurrent invocation output and progress IDs independent", async () => {
    vi.mocked(runAgentLoop).mockImplementation(({ conversation }) => (async function* () {
      const task = conversation.getMessages()[0]!.content[0]!.text!;
      yield { type: "streaming_text", text: `Working on ${task}` };
      yield { type: "assistant_message_complete", text: `Working on ${task}` };
      await Promise.resolve();
      yield { type: "assistant_message_complete", text: `Done: ${task}` };
      yield { type: "turn_complete" };
    })());
    const onProgressUpdate = vi.fn();
    expect(await Promise.all(["one", "two"].map((task) => executeNativeAgent(agent, task, { ...deps, onProgressUpdate }))))
      .toEqual(["Done: one", "Done: two"]);
    expect(new Set(onProgressUpdate.mock.calls.map((call) => call[0])).size).toBe(2);
  });

  it.each(["exhaustion", "failure", "cancellation", "final", "empty final"] as const)(
    "handles real-loop %s after a finding and an empty tool-only completion", async (outcome) => {
      const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
      vi.mocked(runAgentLoop).mockImplementation(actual.runAgentLoop);
      const controller = new AbortController();
      const tool = {
        schema: { name: "inspect", description: "Inspect", inputSchema: { type: "object", properties: {} } },
        execute: vi.fn(async () => {
          if (outcome === "cancellation" && tool.execute.mock.calls.length === 2) controller.abort();
          return { output: "data", isError: false };
        }),
      };
      const streams: StreamEvent[][] = [
        [
          { type: "text_delta", text: "Useful finding" },
          { type: "tool_call_start", toolName: "inspect", toolCallId: "one" },
          { type: "tool_call_delta", toolCallId: "one", argsJson: "{}" },
        ],
        [
          { type: "tool_call_start", toolName: "inspect", toolCallId: "two" },
          { type: "tool_call_delta", toolCallId: "two", argsJson: "{}" },
        ],
        outcome === "failure" ? [{ type: "error", error: new Error("provider failed") }]
          : outcome === "empty final" ? [] : [{ type: "text_delta", text: "Final answer" }],
      ];
      const realProvider: LLMProvider = {
        name: "mock", stream: vi.fn(() => (async function* () {
          for (const event of streams.shift() ?? []) yield event;
        })()),
      };
      const onProgressUpdate = vi.fn();
      const total = outcome === "exhaustion" ? 2 : 3;
      const budget = { remaining: total, total };
      const execution = executeNativeAgent({ ...agent, tools: [tool] }, "task", {
        provider: realProvider, config, permissionMode: "auto-accept", iterationsBudget: budget,
        signal: controller.signal, onProgressUpdate,
      });
      if (outcome === "final" || outcome === "empty final") {
        await expect(execution).resolves.toBe(outcome === "final" ? "Final answer" : "Agent completed with no output.");
        expect(budget.remaining).toBe(0); // A real final answer on the last request succeeds.
        expect(onProgressUpdate).toHaveBeenLastCalledWith(expect.any(String), { type: "turn_complete" });
      } else {
        const reason = outcome === "exhaustion" ? "Agent reached maximum iterations"
          : outcome === "failure" ? "provider failed" : "Aborted";
        await expect(execution).rejects.toThrow(
          `Agent work incomplete: ${reason}\n\nPartial output (not a final answer):\nUseful finding`,
        );
        const events = onProgressUpdate.mock.calls.map(call => call[1]);
        expect(events.at(-1)).toMatchObject({ type: "error", error: new Error(reason) });
        expect(events.some(event => event.type === "turn_complete")).toBe(false);
        if (outcome === "exhaustion") expect(events.at(-1)).toHaveProperty("reason", "iterations_exhausted");
      }
      expect(realProvider.stream).toHaveBeenCalledTimes(outcome === "exhaustion" || outcome === "cancellation" ? 2 : 3);
      expect(tool.execute).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["tool", "targeted"] as const)("marks real exhaustion as an error for the %s caller", async (caller) => {
    const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
    vi.mocked(runAgentLoop).mockImplementation(actual.runAgentLoop);
    const tool = {
      schema: { name: "inspect", description: "Inspect", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ output: "data", isError: false })),
    };
    const realProvider: LLMProvider = {
      name: "mock", stream: vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "Useful finding" };
        yield { type: "tool_call_start", toolName: "inspect", toolCallId: "one" };
        yield { type: "tool_call_delta", toolCallId: "one", argsJson: "{}" };
      })()),
    };
    const onProgressUpdate = vi.fn();
    const realDeps = { provider: realProvider, config: { ...config, maxIterations: 1 }, permissionMode: "auto-accept" as const, onProgressUpdate };
    const realAgent = { ...agent, tools: [tool] };
    const result = caller === "tool" ? await agentToTool(realAgent, realDeps).execute({ task: "task" })
      : await executeTargetedAgent(realAgent, "task", realDeps);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Agent work incomplete: Agent reached maximum iterations");
    expect(result.output).toContain("Partial output (not a final answer):\nUseful finding");
    expect(onProgressUpdate.mock.calls.some(call => call[1].type === "turn_complete")).toBe(false);
    expect(realProvider.stream).toHaveBeenCalledTimes(1);
  });

  it("reports real exhaustion before any output without successful progress", async () => {
    const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
    vi.mocked(runAgentLoop).mockImplementation(actual.runAgentLoop);
    const onProgressUpdate = vi.fn();
    await expect(executeNativeAgent(agent, "task", {
      ...deps, iterationsBudget: { remaining: 0, total: 1 }, onProgressUpdate,
    })).rejects.toThrow("Agent reached maximum iterations");
    expect(provider.stream).not.toHaveBeenCalled();
    expect(onProgressUpdate.mock.calls.map(call => call[1])).toEqual([
      { type: "error", reason: "iterations_exhausted", error: new Error("Agent reached maximum iterations") },
    ]);
  });

  it("returns final-only output with the real loop across narration and tool-only turns, without extra model calls", async () => {
    const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
    vi.mocked(runAgentLoop).mockImplementation(actual.runAgentLoop);
    const tool = {
      schema: { name: "inspect", description: "Inspect", inputSchema: { type: "object", properties: {} } },
      execute: vi.fn(async () => ({ output: "data", isError: false })),
    };
    const streams: StreamEvent[][] = [
      [
        { type: "text_delta", text: "Inspecting" },
        { type: "tool_call_start", toolName: "inspect", toolCallId: "one" },
        { type: "tool_call_delta", toolCallId: "one", argsJson: "{}" },
      ],
      [
        { type: "tool_call_start", toolName: "inspect", toolCallId: "two" },
        { type: "tool_call_delta", toolCallId: "two", argsJson: "{}" },
      ],
      [{ type: "text_delta", text: "Final answer" }],
    ];
    const realProvider: LLMProvider = {
      name: "mock", stream: vi.fn(() => (async function* () {
        for (const event of streams.shift() ?? []) yield event;
      })()),
    };
    const budget = { remaining: 5, total: 5 };
    expect(await executeNativeAgent({ ...agent, tools: [tool] }, "task", {
      provider: realProvider, config, permissionMode: "auto-accept", iterationsBudget: budget,
    })).toBe("Final answer");
    expect(realProvider.stream).toHaveBeenCalledTimes(3);
    expect(tool.execute).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(2);
  });
});
