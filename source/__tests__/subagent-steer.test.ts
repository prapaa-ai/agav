import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real agent loop and steer module; only prevent filesystem/git work.
vi.mock("../utils/worktree.js", () => ({
  createWorktree: vi.fn(async () => null),
  removeWorktree: vi.fn(async () => {}),
  applyWorktreeChanges: vi.fn(async () => ({ applied: true })),
}));

import { ConfirmationQueue } from "../agent/confirmation-queue.js";
import { STEER_DIRECTIVE_PREFIX } from "../agent/internal-prompts.js";
import {
  clearSteers,
  createSteerQueue,
  drainSteers,
  queueSteer,
  queueSubagentSteer,
  steerCommand,
} from "../commands/steer.js";
import type { CommandContext } from "../commands/types.js";
import type { LLMProvider, Message, StreamEvent, StreamParams } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { createSubagentTool, type SubagentToolDeps } from "../tools/subagent.js";
import type { ToolDefinition } from "../tools/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function userTexts(messages: Message[]): string[] {
  return messages.flatMap((message) => message.role === "user"
    ? message.content.flatMap((block) => block.type === "text" ? [block.text ?? ""] : [])
    : []);
}

/** Each child gets its own gate and provider history, even with a shared provider. */
function harness(
  onSteerApplied = vi.fn<(id: string, title: string, directives: string[]) => void>(),
  drainExternalSteers?: SubagentToolDeps["drainSteers"],
) {
  const gates = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const calls = new Map<string, StreamParams[]>();
  const acknowledgementsAtRequest = new Map<string, number[]>();
  const registry = new ToolRegistry();
  const gateTool: ToolDefinition = {
    schema: {
      name: "gate_tool",
      description: "Wait for this child's gate",
      destructive: false,
      inputSchema: {
        type: "object",
        properties: { child: { type: "string" } },
        required: ["child"],
      },
    },
    async execute(input) {
      const gate = gates.get(String(input.child))!;
      gate.entered.resolve();
      await gate.release.promise;
      return { output: "released", isError: false };
    },
  };
  registry.register(gateTool);

  const provider: LLMProvider = {
    name: "mock",
    async *stream(params): AsyncGenerator<StreamEvent> {
      const child = userTexts(params.messages)[0]!;
      const history = calls.get(child) ?? [];
      // Snapshot now: later conversation mutations must not make old requests
      // appear to have received a directive they did not actually see.
      history.push({ ...params, messages: structuredClone(params.messages) });
      calls.set(child, history);
      const acknowledgements = acknowledgementsAtRequest.get(child) ?? [];
      acknowledgements.push(onSteerApplied.mock.calls.filter((call) => call[1] === child).length);
      acknowledgementsAtRequest.set(child, acknowledgements);
      if (history.length <= 2) {
        // A second tool round checks that a drained directive is not repeated.
        const toolCallId = `${child}-${history.length}`;
        yield { type: "tool_call_start", toolCallId, toolName: "gate_tool" };
        yield { type: "tool_call_delta", toolCallId, argsJson: JSON.stringify({ child }) };
      } else {
        yield { type: "text_delta", text: `${child} finished` };
      }
    },
  };

  const tool = createSubagentTool({
    provider,
    parentToolRegistry: registry,
    getConfig: () => ({
      model: "test-model",
      systemPrompt: "You are a test agent.",
      permissionMode: "auto-accept" as const,
      effort: "medium" as const,
      iterationsBudget: { remaining: 20, total: 20 },
    }),
    confirmationQueue: new ConfirmationQueue(),
    onProgressUpdate: vi.fn(),
    onTokenUsage: vi.fn(),
    onSteerApplied,
    drainSteers: drainExternalSteers,
    getSignal: () => undefined,
  });

  function start(child: string) {
    const gate = { entered: deferred(), release: deferred() };
    gates.set(child, gate);
    // Non-write task labels also avoid changing cwd in parallel executions.
    const finished = tool.execute({ title: child, task: child });
    return { ...gate, finished };
  }

  return { tool, start, calls, acknowledgementsAtRequest, onSteerApplied };
}

beforeEach(() => {
  clearSteers();
  vi.useFakeTimers();
});

afterEach(() => {
  clearSteers();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("subagent mid-turn steering with the real agent loop", () => {
  it("delivers only to addressed parallel children before their next request and acknowledges each named child once", async () => {
    const h = harness();
    const a = h.start("Analyze logs");
    const b = h.start("Read config");
    await Promise.all([a.entered.promise, b.entered.promise]);

    queueSteer("main only");
    queueSubagentSteer("sa-1", "focus on the parser");
    queueSubagentSteer("sa-1", "keep the report concise");
    queueSubagentSteer("sa-2", "review config only");
    expect(h.onSteerApplied).not.toHaveBeenCalled();
    expect(h.calls.get("Analyze logs")).toHaveLength(1);
    expect(h.calls.get("Read config")).toHaveLength(1);

    a.release.resolve();
    expect(await a.finished).toEqual({ output: "Analyze logs finished", isError: false });
    expect(h.onSteerApplied.mock.calls).toEqual([
      ["sa-1", "Analyze logs", ["focus on the parser", "keep the report concise"]],
    ]);
    // Neither the first child nor the main drain consumes child B's directives.
    expect(drainSteers()).toEqual(["main only"]);
    expect(drainSteers()).toEqual([]);
    b.release.resolve();
    expect(await b.finished).toEqual({ output: "Read config finished", isError: false });
    expect(h.onSteerApplied.mock.calls).toEqual([
      ["sa-1", "Analyze logs", ["focus on the parser", "keep the report concise"]],
      ["sa-2", "Read config", ["review config only"]],
    ]);

    for (const child of ["Analyze logs", "Read config"]) {
      const requests = h.calls.get(child)!;
      expect(requests).toHaveLength(3);
      expect(h.acknowledgementsAtRequest.get(child)).toEqual([0, 1, 1]);
      expect(userTexts(requests[0]!.messages)).toEqual([child]);
      for (const request of requests.slice(1)) {
        expect(userTexts(request.messages).filter((text) => text.startsWith(STEER_DIRECTIVE_PREFIX)))
          .toEqual((child === "Analyze logs"
            ? ["focus on the parser", "keep the report concise"]
            : ["review config only"]).map((text) => STEER_DIRECTIVE_PREFIX + text));
      }
      // Steering must not split tool_use from its matching tool_result.
      const messages = requests[1]!.messages;
      const useIndex = messages.findIndex((message) => message.content.some((block) => block.type === "tool_use"));
      expect(useIndex).toBeGreaterThanOrEqual(0);
      expect(messages[useIndex + 1]!.content).toEqual([
        expect.objectContaining({ type: "tool_result", toolCallId: `${child}-1` }),
      ]);
      expect(messages[useIndex + 2]!.content[0]).toEqual({
        type: "text", text: STEER_DIRECTIVE_PREFIX + (child === "Analyze logs" ? "focus on the parser" : "review config only"),
      });
    }
  });

  it("does not acknowledge completed or cancelled children, or replay their directives to later children", async () => {
    const h = harness();
    const completed = h.start("Analyze completed task");
    await completed.entered.promise;
    completed.release.resolve();
    expect((await completed.finished).isError).toBe(false);

    const cancelled = h.start("Analyze cancelled task");
    await cancelled.entered.promise;
    queueSubagentSteer("sa-2", "pending at cancellation");
    h.tool.cancelSubagent("sa-2");
    cancelled.release.resolve();
    expect(await cancelled.finished).toEqual({ output: "Subagent cancelled.", isError: true });
    expect(h.calls.get("Analyze cancelled task")).toHaveLength(1);

    expect(() => queueSubagentSteer("sa-1", "too late")).toThrow("not active");
    expect(() => queueSubagentSteer("sa-2", "too late")).toThrow("not active");
    queueSteer("after both children stopped");
    const fresh = h.start("Analyze fresh task");
    await fresh.entered.promise;
    fresh.release.resolve();
    expect((await fresh.finished).isError).toBe(false);
    expect(h.onSteerApplied).not.toHaveBeenCalled();
    for (const request of h.calls.get("Analyze fresh task")!) {
      expect(userTexts(request.messages)).toEqual(["Analyze fresh task"]);
    }
    expect(drainSteers()).toEqual(["after both children stopped"]);
  });

  it("does not inherit active main steers or historical queued main directives", async () => {
    await steerCommand.execute("Use the project conventions", {} as CommandContext);
    queueSteer("historical broadcast only");
    const h = harness();
    const child = h.start("Analyze startup context");
    await child.entered.promise;

    const firstRequest = h.calls.get("Analyze startup context")![0]!;
    expect(firstRequest.systemPrompt).not.toContain("Active steering directives");
    expect(firstRequest.systemPrompt).not.toContain("Use the project conventions");
    expect(firstRequest.systemPrompt).not.toContain("historical broadcast only");
    expect(userTexts(firstRequest.messages)).toEqual(["Analyze startup context"]);
    expect(h.onSteerApplied).not.toHaveBeenCalled();

    queueSubagentSteer("sa-1", "new live direction");
    child.release.resolve();
    expect((await child.finished).isError).toBe(false);
    expect(h.onSteerApplied.mock.calls).toEqual([
      ["sa-1", "Analyze startup context", ["new live direction"]],
    ]);
    expect(userTexts(h.calls.get("Analyze startup context")![1]!.messages)).toEqual([
      "Analyze startup context", STEER_DIRECTIVE_PREFIX + "new live direction",
    ]);
    expect(drainSteers()).toEqual([
      "Use the project conventions", "historical broadcast only",
    ]);
  });

  it("awaits worker child drains and combines them with only that child's local queue", async () => {
    const queues = new Map<string, string[]>();
    const drain = vi.fn(async (id: string) => {
      await Promise.resolve();
      return queues.get(id)?.splice(0) ?? [];
    });
    const h = harness(undefined, drain);
    const a = h.start("Analyze worker logs");
    const b = h.start("Read worker config");
    await Promise.all([a.entered.promise, b.entered.promise]);
    queues.set("sa-1", ["worker first child"]);
    queues.set("sa-2", ["worker second child"]);
    queueSubagentSteer("sa-1", "local first child");
    queueSteer("main only");
    a.release.resolve();
    b.release.resolve();
    expect((await a.finished).isError).toBe(false);
    expect((await b.finished).isError).toBe(false);
    expect(h.onSteerApplied.mock.calls).toEqual(expect.arrayContaining([
      ["sa-1", "Analyze worker logs", ["worker first child", "local first child"]],
      ["sa-2", "Read worker config", ["worker second child"]],
    ]));
    expect(h.onSteerApplied).toHaveBeenCalledTimes(2);
    expect(h.acknowledgementsAtRequest.get("Analyze worker logs")).toEqual([0, 1, 1]);
    expect(h.acknowledgementsAtRequest.get("Read worker config")).toEqual([0, 1, 1]);
    expect(new Set(drain.mock.calls.map(([id]) => id))).toEqual(new Set(["sa-1", "sa-2"]));
    expect(drainSteers()).toEqual(["main only"]);
  });

  it("clearing main steers leaves child deliveries intact", async () => {
    const h = harness();
    const a = h.start("Analyze first task");
    const b = h.start("Analyze second task");
    await Promise.all([a.entered.promise, b.entered.promise]);
    queueSteer("discard main directive");
    queueSubagentSteer("sa-1", "first child only");
    clearSteers();
    expect(drainSteers()).toEqual([]);
    a.release.resolve();
    b.release.resolve();
    expect((await a.finished).isError).toBe(false);
    expect((await b.finished).isError).toBe(false);
    expect(h.onSteerApplied.mock.calls).toEqual([["sa-1", "Analyze first task", ["first child only"]]]);
  });
});

describe("independent steer queue lifecycle", () => {
  it("isolates main, named children and anonymous queues, and unregisters on dispose", () => {
    queueSteer("before registration");
    const a = createSteerQueue("a");
    const b = createSteerQueue("b");
    const anonymous = createSteerQueue();
    try {
      expect(a.drain()).toEqual([]);
      queueSubagentSteer("a", "one");
      queueSubagentSteer("a", "two");
      queueSubagentSteer("b", "sibling only");
      queueSteer("main only");
      expect(a.drain()).toEqual(["one", "two"]);
      expect(a.drain()).toEqual([]);
      expect(b.drain()).toEqual(["sibling only"]);
      expect(anonymous.drain()).toEqual([]);
      expect(drainSteers()).toEqual(["before registration", "main only"]);
      queueSubagentSteer("a", "discard on dispose");
      a.dispose();
      a.dispose();
      expect(a.drain()).toEqual([]);
      expect(() => queueSubagentSteer("a", "too late")).toThrow("not active");
      expect(() => queueSubagentSteer("missing", "unknown")).toThrow("not active");
      queueSubagentSteer("b", "still active");
      clearSteers();
      expect(b.drain()).toEqual(["still active"]);
    } finally { a.dispose(); b.dispose(); anonymous.dispose(); }
  });

  it("allows an ID to be registered again without an old disposer unregistering it", () => {
    const old = createSteerQueue("reused");
    old.dispose();
    const fresh = createSteerQueue("reused");
    try {
      old.dispose();
      queueSubagentSteer("reused", "fresh only");
      expect(fresh.drain()).toEqual(["fresh only"]);
      expect(old.drain()).toEqual([]);
    } finally { fresh.dispose(); }
  });
});
