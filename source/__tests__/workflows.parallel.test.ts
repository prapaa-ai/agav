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
  stream = vi.fn((_params: StreamParams) => (async function* () {
    yield { type: "text_delta" as const, text: "mock response" };
    yield { type: "usage" as const, inputTokens: 10, outputTokens: 3 };
  })());
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
  return { version: 1, name: "parallel-flow", policies, nodes };
}

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { schema: { name, description: name, inputSchema: { type: "object" } }, execute };
}

describe("workflow parallel node", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-parallel-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("executes children concurrently and aggregates outputs", async () => {
    registry.register(tool("left", async () => ({ output: "L", isError: false })));
    registry.register(tool("right", async () => ({ output: "R", isError: false })));

    const run = await runWorkflow(workflow([
      {
        id: "fan_out",
        type: "parallel",
        children: [
          { id: "left", type: "tool", tool: "left" },
          { id: "right", type: "tool", tool: "right" },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    const parent = await store.loadNode(run.id, "fan_out");
    expect(parent).toMatchObject({ status: "passed" });
    expect(parent?.output).toEqual({ childOutputs: { left: "L", right: "R" } });
    expect(await store.loadNode(run.id, "left")).toMatchObject({ status: "passed", output: "L" });
    expect(await store.loadNode(run.id, "right")).toMatchObject({ status: "passed", output: "R" });
  });

  it("respects intra-parallel child dependencies", async () => {
    const order: string[] = [];
    registry.register(tool("first", async () => {
      order.push("first");
      return { output: "one", isError: false };
    }));
    registry.register(tool("second", async () => {
      order.push("second");
      return { output: "two", isError: false };
    }));

    const run = await runWorkflow(workflow([
      {
        id: "fan_out",
        type: "parallel",
        children: [
          { id: "a_second", type: "tool", tool: "second", dependsOn: ["a_first"] },
          { id: "a_first", type: "tool", tool: "first" },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    expect(order).toEqual(["first", "second"]);
  });

  it("lets a sibling child depend on an upstream top-level node", async () => {
    registry.register(tool("upstream", async () => ({ output: "seed", isError: false })));
    registry.register(tool("downstream", async () => ({ output: "done", isError: false })));

    const run = await runWorkflow(workflow([
      { id: "seed", type: "tool", tool: "upstream" },
      {
        id: "fan_out",
        type: "parallel",
        dependsOn: ["seed"],
        children: [{ id: "child", type: "tool", tool: "downstream" }],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    expect(await store.loadNode(run.id, "fan_out")).toMatchObject({ status: "passed" });
  });

  it("fails the parallel node when a child fails", async () => {
    registry.register(tool("good", async () => ({ output: "ok", isError: false })));
    registry.register(tool("bad", async () => ({ output: "boom", isError: true })));

    const run = await runWorkflow(workflow([
      {
        id: "fan_out",
        type: "parallel",
        children: [
          { id: "ok_child", type: "tool", tool: "good" },
          { id: "bad_child", type: "tool", tool: "bad" },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
    expect(await store.loadNode(run.id, "fan_out")).toMatchObject({ status: "failed" });
    expect(await store.loadNode(run.id, "bad_child")).toMatchObject({ status: "failed" });
  });

  it("surfaces waiting approval children as a waiting parallel node", async () => {
    registry.register(tool("noop", async () => ({ output: "done", isError: false })));

    const run = await runWorkflow(workflow([
      {
        id: "fan_out",
        type: "parallel",
        children: [
          { id: "gate", type: "approval", prompt: "approve?" },
          { id: "work", type: "tool", tool: "noop" },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("waiting_approval");
    expect(await store.loadNode(run.id, "fan_out")).toMatchObject({ status: "waiting_approval" });
    expect(await store.loadNode(run.id, "gate")).toMatchObject({ status: "waiting_approval" });
  });

  it("resumes children from checkpoints instead of re-running them", async () => {
    const leftExecute = vi.fn(async () => ({ output: "L", isError: false }));
    const rightExecute = vi.fn(async () => ({ output: "R", isError: false }));
    registry.register(tool("left", leftExecute));
    registry.register(tool("right", rightExecute));

    const run = await runWorkflow(workflow([
      {
        id: "fan_out",
        type: "parallel",
        children: [
          { id: "l", type: "tool", tool: "left" },
          { id: "r", type: "tool", tool: "right" },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    expect(leftExecute).toHaveBeenCalledTimes(1);
    expect(rightExecute).toHaveBeenCalledTimes(1);

    await store.saveNode(run.id, { ...(await store.loadNode(run.id, "fan_out"))!, status: "running", endedAt: undefined });
    const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(resumed.status).toBe("passed");
    expect(leftExecute).toHaveBeenCalledTimes(1);
    expect(rightExecute).toHaveBeenCalledTimes(1);
  });

  it("rejects children that depend on nodes scoped inside another parallel node", async () => {
    const result = await validateWorkflow(workflow([
      {
        id: "other_fan_out",
        type: "parallel",
        children: [{ id: "nested_inside_other", type: "tool", tool: "a" }],
      },
      {
        id: "fan_out",
        type: "parallel",
        children: [
          { id: "inside", type: "tool", tool: "b" },
          { id: "outside", type: "tool", tool: "c", dependsOn: ["nested_inside_other"] },
        ],
      },
    ]), { hasTool: () => true });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("may only depend on sibling children"))).toBe(true);
  });

  it("rejects non-positive maxConcurrency", async () => {
    const result = await validateWorkflow(workflow([
      { id: "fan_out", type: "parallel", maxConcurrency: 0, children: [{ id: "c", type: "tool", tool: "a" }] },
    ]), { hasTool: () => true });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("maxConcurrency"))).toBe(true);
  });

  it("records parallel child attempts and keeps retry scoped to the parent", async () => {
    let calls = 0;
    registry.register(tool("flaky", async () => {
      calls++;
      return calls === 1 ? { output: "bad", isError: true } : { output: "good", isError: false };
    }));
    registry.register(tool("stable", async () => ({ output: "S", isError: false })));

    const run = await runWorkflow(workflow([
      {
        id: "fan_out",
        type: "parallel",
        children: [
          { id: "f", type: "tool", tool: "flaky" },
          { id: "s", type: "tool", tool: "stable" },
        ],
      },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
    expect(await store.listNodeAttempts(run.id, "f")).toMatchObject([{ attempt: 1, status: "failed" }]);
    expect(await store.loadNode(run.id, "s")).toMatchObject({ status: "passed" });
  });
});
