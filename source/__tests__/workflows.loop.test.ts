import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { runWorkflow, resumeWorkflow, type AgentExecutionOptions } from "../workflows/runtime.js";
import { validateWorkflow } from "../workflows/validator.js";
import { WorkflowStore } from "../workflows/store.js";
import type { WorkflowDefinition, WorkflowNodeDefinition } from "../workflows/types.js";

class MockProvider implements LLMProvider {
  name = "mock";
  stream = vi.fn((_params: StreamParams) => (async function* () {})());
}

const config: AgavConfig = {
  provider: "openai",
  model: "mock-model",
  effort: "low",
  maxTokens: 1000,
  maxIterations: 10,
  errorRetries: 0,
  permissionMode: "ask",
};

function makeAgent(name: string): AgentDefinition {
  return {
    manifest: { name, description: `${name} agent`, version: "1.0.0", type: "native" },
    systemPrompt: "agent prompt",
    tools: [],
    origin: "project",
    path: process.cwd(),
  };
}

function workflow(nodes: WorkflowNodeDefinition[], policies: WorkflowDefinition["policies"] = { sandbox: "none" }): WorkflowDefinition {
  return { version: 1, name: "loop-flow", policies, nodes };
}

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { schema: { name, description: name, inputSchema: { type: "object" } }, execute };
}

describe("workflow loop node", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;
  let provider: MockProvider;
  // Typed to the signatures WorkflowRuntimeDeps declares. An untyped vi.fn() mock is
  // not assignable to those.
  let loadAgent: MockedFunction<(name: string) => Promise<AgentDefinition | null>>;
  let executeAgent: MockedFunction<
    (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string>
  >;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-loop-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stops early once the stopWhen node reaches the target status", async () => {
    let attempt = 0;
    registry.register(tool("noop", async () => ({ output: "n", isError: false })));
    registry.register(tool("check", async () => {
      attempt++;
      return { output: `check-${attempt}`, isError: attempt < 3 };
    }));

    const run = await runWorkflow(workflow([
      {
        id: "fix_until_green",
        type: "loop",
        maxIterations: 5,
        stopOnFailure: false,
        stopWhen: { node: "check", status: "passed" },
        body: [
          { id: "fix", type: "tool", tool: "noop" },
          { id: "check", type: "tool", tool: "check", dependsOn: ["fix"] },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    const node = await store.loadNode(run.id, "fix_until_green");
    const output = node?.output as { completedIterations: number; stoppedEarly: boolean };
    expect(output.stoppedEarly).toBe(true);
    expect(output.completedIterations).toBe(3);
  });

  it("runs body nodes in dependency order each iteration", async () => {
    const order: string[] = [];
    registry.register(tool("first", async () => {
      order.push("first");
      return { output: "1", isError: false };
    }));
    registry.register(tool("second", async () => {
      order.push("second");
      return { output: "2", isError: false };
    }));

    const run = await runWorkflow(workflow([
      {
        id: "once",
        type: "loop",
        maxIterations: 1,
        body: [
          { id: "b", type: "tool", tool: "second", dependsOn: ["a"] },
          { id: "a", type: "tool", tool: "first" },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    expect(order).toEqual(["first", "second"]);
  });

  it("aggregates per-iteration outputs", async () => {
    let attempt = 0;
    registry.register(tool("check", async () => {
      attempt++;
      return { output: `try-${attempt}`, isError: attempt < 2 };
    }));

    const run = await runWorkflow(workflow([
      {
        id: "retry_until_ok",
        type: "loop",
        maxIterations: 4,
        stopOnFailure: false,
        stopWhen: { node: "check", status: "passed" },
        body: [{ id: "check", type: "tool", tool: "check" }],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    const node = await store.loadNode(run.id, "retry_until_ok");
    expect(node).toMatchObject({ status: "passed" });
    const output = node?.output as { iterations: unknown[]; completedIterations: number; stoppedEarly: boolean };
    expect(output.completedIterations).toBe(2);
    expect(output.stoppedEarly).toBe(true);
    expect(output.iterations).toHaveLength(2);
  });

  it("fails when maxIterations is exhausted without satisfying stopWhen", async () => {
    registry.register(tool("never_green", async () => ({ output: "still broken", isError: true })));

    const run = await runWorkflow(workflow([
      {
        id: "hopeless",
        type: "loop",
        maxIterations: 2,
        stopOnFailure: false,
        stopWhen: { node: "check", status: "passed" },
        body: [{ id: "check", type: "tool", tool: "never_green" }],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
    expect(await store.loadNode(run.id, "hopeless")).toMatchObject({ status: "failed" });
  });

  it("fails fast when a body node fails and stopOnFailure is enabled", async () => {
    let calls = 0;
    registry.register(tool("broken", async () => {
      calls++;
      return { output: "boom", isError: true };
    }));

    const run = await runWorkflow(workflow([
      {
        id: "fast_fail",
        type: "loop",
        maxIterations: 5,
        body: [{ id: "work", type: "tool", tool: "broken" }],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("gives each iteration its own checkpoint identity", async () => {
    let attempt = 0;
    registry.register(tool("check", async () => {
      attempt++;
      return { output: `try-${attempt}`, isError: attempt < 2 };
    }));

    const run = await runWorkflow(workflow([
      {
        id: "iters",
        type: "loop",
        maxIterations: 3,
        stopOnFailure: false,
        stopWhen: { node: "check", status: "passed" },
        body: [{ id: "check", type: "tool", tool: "check" }],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(await store.loadNode(run.id, "check#1")).toMatchObject({ status: "failed" });
    expect(await store.loadNode(run.id, "check#2")).toMatchObject({ status: "passed", output: "try-2" });
  });

  it("does not re-execute completed iterations when resuming", async () => {
    let attempt = 0;
    const checkExecute = vi.fn(async () => {
      attempt++;
      return { output: `try-${attempt}`, isError: attempt < 2 };
    });
    registry.register(tool("check", checkExecute));

    const run = await runWorkflow(workflow([
      {
        id: "iters",
        type: "loop",
        maxIterations: 3,
        stopOnFailure: false,
        stopWhen: { node: "check", status: "passed" },
        body: [{ id: "check", type: "tool", tool: "check" }],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    expect(checkExecute).toHaveBeenCalledTimes(2);

    // Simulate an interrupted loop: mark the parent as running again.
    const parent = await store.loadNode(run.id, "iters");
    await store.saveNode(run.id, { ...parent!, status: "running", endedAt: undefined });

    const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(resumed.status).toBe("passed");
    // Iteration 1 and 2 checkpoints already exist and must not be redone.
    expect(checkExecute).toHaveBeenCalledTimes(2);
  });

  it("rejects a stopWhen node that is not part of the body", async () => {
    registry.register(tool("noop", async () => ({ output: "n", isError: false })));

    const result = await validateWorkflow(workflow([
      {
        id: "bad_loop",
        type: "loop",
        maxIterations: 1,
        stopWhen: { node: "elsewhere" },
        body: [{ id: "work", type: "tool", tool: "noop" }],
      },
    ]), { hasTool: () => true });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("Unknown stopWhen node"))).toBe(true);
  });

  it("fails at runtime when a stopWhen node escapes body scope", async () => {
    registry.register(tool("noop", async () => ({ output: "n", isError: false })));

    // Bypass validation by constructing the run definition directly so the
    // runtime guard is exercised rather than the validator.
    const run = await runWorkflow(workflow([
      { id: "other", type: "tool", tool: "noop" },
      {
        id: "bad_loop",
        type: "loop",
        maxIterations: 1,
        stopWhen: { node: "other" },
        body: [{ id: "work", type: "tool", tool: "noop" }],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
  });

  it("surfaces a waiting approval body node as a waiting loop", async () => {
    registry.register(tool("noop", async () => ({ output: "n", isError: false })));

    const run = await runWorkflow(workflow([
      {
        id: "gated",
        type: "loop",
        maxIterations: 2,
        body: [
          { id: "gate", type: "approval", prompt: "continue?" },
          { id: "work", type: "tool", tool: "noop", dependsOn: ["gate"] },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("waiting_approval");
    expect(await store.loadNode(run.id, "gated")).toMatchObject({ status: "waiting_approval" });
    expect(await store.loadNode(run.id, "gate#1")).toMatchObject({ status: "waiting_approval" });
  });

  it("keeps body node dependencies scoped to the body", async () => {
    const result = await validateWorkflow(workflow([
      {
        id: "other_fan_out",
        type: "parallel",
        children: [{ id: "nested", type: "tool", tool: "a" }],
      },
      {
        id: "looper",
        type: "loop",
        body: [
          { id: "in_body", type: "tool", tool: "b" },
          { id: "out_of_body", type: "tool", tool: "c", dependsOn: ["nested"] },
        ],
      },
    ]), { hasTool: () => true });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("may only depend on other body nodes"))).toBe(true);
  });

  it("rejects non-positive maxIterations", async () => {
    const result = await validateWorkflow(workflow([
      { id: "looper", type: "loop", maxIterations: 0, body: [{ id: "w", type: "tool", tool: "a" }] },
    ]), { hasTool: () => true });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("maxIterations"))).toBe(true);
  });
});
