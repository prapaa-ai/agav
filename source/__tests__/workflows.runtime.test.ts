import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { WorkflowStore } from "../workflows/store.js";
import { runWorkflow, resumeWorkflow, type AgentExecutionOptions } from "../workflows/runtime.js";
import { validateWorkflow } from "../workflows/validator.js";
import type { WorkflowDefinition } from "../workflows/types.js";

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

function baseWorkflow(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return {
    version: 1,
    name: "test-workflow",
    description: "Test workflow",
    policies: { maxConcurrency: 2, sandbox: "none" },
    nodes,
  };
}

describe("workflow runtime", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;
  let provider: MockProvider;
  // Typed to the signatures WorkflowRuntimeDeps declares. An untyped vi.fn() mock is
  // not assignable to those, and the mock helpers below would break.
  let loadAgent: MockedFunction<(name: string) => Promise<AgentDefinition | null>>;
  let executeAgent: MockedFunction<
    (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string>
  >;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-runtime-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string, _options: AgentExecutionOptions) =>
      `agent output: ${task}`,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("validates missing dependencies and unknown tools", async () => {
    const workflow = baseWorkflow([
      { id: "a", type: "tool", tool: "missing_tool", dependsOn: ["nope"] },
    ]);

    const result = await validateWorkflow(workflow, { hasTool: () => false });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "Unknown dependency: nope",
      "Unknown tool: missing_tool",
    ]));
  });

  it("runs tool, agent, and test nodes in dependency order and checkpoints them", async () => {
    const calls: string[] = [];
    const echoTool: ToolDefinition = {
      schema: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      execute: vi.fn(async (input) => {
        calls.push("tool");
        return { output: JSON.stringify({ message: `hello ${input.name}` }), isError: false };
      }),
    };
    registry.register(echoTool);

    executeAgent.mockImplementation(async (_agent: AgentDefinition, task: string) => {
      calls.push("agent");
      return `agent saw ${task}`;
    });

    const workflow = baseWorkflow([
      { id: "first", type: "tool", tool: "echo", input: { name: "agav" } },
      { id: "second", type: "agent", agent: "internal_agent", task: "Use ${nodes.first.output.message}", dependsOn: ["first"] },
      { id: "assert", type: "test", dependsOn: ["second"], assertions: [{ type: "output_contains", node: "second", value: "hello agav" }] },
    ]);

    const run = await runWorkflow(workflow, {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    expect(calls).toEqual(["tool", "agent"]);
    expect(await store.loadNode(run.id, "first")).toMatchObject({ status: "passed", output: { message: "hello agav" } });
    expect(await store.loadNode(run.id, "second")).toMatchObject({ status: "passed" });
    expect(await store.loadNode(run.id, "assert")).toMatchObject({ status: "passed" });
  });

  it("resumes by skipping passed checkpoints", async () => {
    const tool: ToolDefinition = {
      schema: { name: "once", description: "once", inputSchema: { type: "object" } },
      execute: vi.fn(async () => ({ output: "done", isError: false })),
    };
    registry.register(tool);

    const workflow = baseWorkflow([
      { id: "first", type: "tool", tool: "once" },
      { id: "approve", type: "approval", prompt: "continue?", dependsOn: ["first"] },
      { id: "final", type: "agent", agent: "internal_agent", task: "finish", dependsOn: ["approve"] },
    ]);

    const initial = await runWorkflow(workflow, {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    expect(initial.status).toBe("waiting_approval");
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(executeAgent).not.toHaveBeenCalled();

    const resumed = await resumeWorkflow(initial.id, {
      provider,
      config,
      toolRegistry: registry,
      loadAgent,
      executeAgent,
      store,
      confirm: vi.fn(async () => ({ decision: "approved" as const, approvedBy: "test" })),
    });

    expect(resumed.status).toBe("passed");
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(await store.loadNode(initial.id, "approve")).toMatchObject({ status: "passed", approval: { decision: "approved" } });
  });

  it("reruns interrupted running nodes on resume", async () => {
    let calls = 0;
    const tool: ToolDefinition = {
      schema: { name: "flaky", description: "flaky", inputSchema: { type: "object" } },
      execute: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("crash");
        return { output: "recovered", isError: false };
      }),
    };
    registry.register(tool);

    // retrySafe opts this node into an automatic retry on resume. Without it the
    // runtime correctly requires approval to retry an interrupted tool node, and
    // the run would stop at waiting_approval rather than recovering as tested.
    const workflow = baseWorkflow([{ id: "flaky_node", type: "tool", tool: "flaky", retrySafe: true }]);
    const failed = await runWorkflow(workflow, {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    expect(failed.status).toBe("failed");

    // Simulate an interrupted process that left the node marked running.
    const node = await store.loadNode(failed.id, "flaky_node");
    await store.saveNode(failed.id, { ...node!, status: "running", endedAt: undefined, error: undefined });

    const resumed = await resumeWorkflow(failed.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(resumed.status).toBe("passed");
    expect(tool.execute).toHaveBeenCalledTimes(2);
    expect(await store.loadNode(failed.id, "flaky_node")).toMatchObject({ status: "passed", output: "recovered" });
  });

  it("supports prompt nodes with isolated context and usage checkpointing", async () => {
    const workflow = baseWorkflow([{ id: "summarize", type: "prompt", prompt: "Summarize ${inputs.topic}", model: "cheap", effort: "low" }]);

    const run = await runWorkflow(workflow, { topic: "logs" }, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    expect(provider.stream).toHaveBeenCalledWith(expect.objectContaining({ model: "cheap", effort: "low" }));
    expect(await store.loadNode(run.id, "summarize")).toMatchObject({
      status: "passed",
      output: "mock response",
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });
});
