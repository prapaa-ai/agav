import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { retryWorkflowNode } from "../workflows/control.js";
import { resumeWorkflow, runWorkflow , type AgentExecutionOptions} from "../workflows/runtime.js";
import { WorkflowStore } from "../workflows/store.js";
import type { WorkflowDefinition } from "../workflows/types.js";

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

function workflow(nodes: WorkflowDefinition["nodes"], policies: WorkflowDefinition["policies"] = { sandbox: "none" }): WorkflowDefinition {
  return { version: 1, name: "attempt-flow", policies, nodes };
}

describe("workflow attempt history and cooperative cancellation", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-attempts-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists terminal node attempts and increments after retry", async () => {
    let calls = 0;
    const tool: ToolDefinition = {
      schema: { name: "flaky", description: "flaky", inputSchema: { type: "object" } },
      execute: vi.fn(async () => {
        calls++;
        return calls === 1 ? { output: "bad", isError: true } : { output: "ok", isError: false };
      }),
    };
    registry.register(tool);

    const run = await runWorkflow(workflow([{ id: "flaky_node", type: "tool", tool: "flaky" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    expect(run.status).toBe("failed");
    expect(await store.listNodeAttempts(run.id, "flaky_node")).toMatchObject([{ attempt: 1, status: "failed" }]);

    await retryWorkflowNode(run.id, "flaky_node", store);
    const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(resumed.status).toBe("passed");
    expect(await store.listNodeAttempts(run.id, "flaky_node")).toMatchObject([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "passed" },
    ]);
  });

  it("marks nodes timed_out when node timeout is exceeded", async () => {
    const tool: ToolDefinition = {
      schema: { name: "slow", description: "slow", inputSchema: { type: "object" } },
      execute: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { output: "late", isError: false };
      }),
    };
    registry.register(tool);

    const run = await runWorkflow(workflow([{ id: "slow_node", type: "tool", tool: "slow", timeoutSeconds: 0.001 }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
    expect(await store.loadNode(run.id, "slow_node")).toMatchObject({ status: "timed_out", error: expect.stringContaining("timed out") });
    expect(await store.listNodeAttempts(run.id, "slow_node")).toMatchObject([{ status: "timed_out" }]);
  });

  it("pauses before execution when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const run = await runWorkflow(workflow([{ id: "first", type: "approval", prompt: "ok?" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store }, { signal: controller.signal });

    expect(run.status).toBe("paused");
    expect(await store.loadNodes(run.id)).toEqual({});
  });
});
