import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { decideWorkflowApproval, cancelWorkflow, getWorkflowRunSummary, pauseWorkflow, retryWorkflowNode } from "../workflows/control.js";
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

function workflow(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return { version: 1, name: "control-flow", policies: { sandbox: "none" }, nodes };
}

describe("workflow run control", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-control-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists runs sorted by updatedAt and returns run summaries", async () => {
    const first = await runWorkflow(workflow([{ id: "approve", type: "approval", prompt: "first" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store, now: () => new Date("2026-01-01T00:00:00Z") });
    const second = await runWorkflow(workflow([{ id: "approve", type: "approval", prompt: "second" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store, now: () => new Date("2026-01-02T00:00:00Z") });

    const runs = await store.listRuns();
    expect(runs.map((run) => run.id)).toEqual([second.id, first.id]);

    const summary = await getWorkflowRunSummary(first.id, store);
    expect(summary.run.id).toBe(first.id);
    expect(summary.nodes).toHaveLength(1);
    expect(summary.nodes[0]).toMatchObject({ id: "approve", status: "waiting_approval" });
    expect(summary.pendingNodes).toEqual([]);
  });

  it("reports pending nodes that do not have checkpoints yet", async () => {
    const tool: ToolDefinition = {
      schema: { name: "fail", description: "fail", inputSchema: { type: "object" } },
      execute: vi.fn(async () => ({ output: "failed", isError: true })),
    };
    registry.register(tool);
    const run = await runWorkflow(workflow([
      { id: "first", type: "tool", tool: "fail" },
      { id: "second", type: "agent", agent: "worker", task: "next", dependsOn: ["first"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await getWorkflowRunSummary(run.id, store);

    expect(summary.nodes.map((node) => node.id)).toEqual(["first"]);
    expect(summary.pendingNodes).toEqual([{ id: "second", type: "agent", dependsOn: ["first"] }]);
  });

  it("records approval decisions separately and resumes without re-prompting", async () => {
    const tool: ToolDefinition = {
      schema: { name: "once", description: "once", inputSchema: { type: "object" } },
      execute: vi.fn(async () => ({ output: "done", isError: false })),
    };
    registry.register(tool);
    const run = await runWorkflow(workflow([
      { id: "first", type: "tool", tool: "once" },
      { id: "approve", type: "approval", prompt: "continue?", dependsOn: ["first"] },
      { id: "final", type: "agent", agent: "worker", task: "finish", dependsOn: ["approve"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("waiting_approval");
    await decideWorkflowApproval(run.id, "approve", { decision: "approved", approvedBy: "test" }, store);

    const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(resumed.status).toBe("passed");
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it("denies waiting approval nodes and leaves run failed", async () => {
    const run = await runWorkflow(workflow([{ id: "approve", type: "approval", prompt: "continue?" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const node = await decideWorkflowApproval(run.id, "approve", { decision: "denied", approvedBy: "test" }, store);
    const updated = await store.loadRun(run.id);

    expect(node).toMatchObject({ status: "failed", approval: { decision: "denied" } });
    expect(updated).toMatchObject({ status: "failed", failedNodeIds: ["approve"] });
  });

  it("pauses and cancels runs, and cancelled runs require force to resume", async () => {
    const run = await runWorkflow(workflow([{ id: "approve", type: "approval", prompt: "continue?" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    await pauseWorkflow(run.id, "operator pause", store);
    expect(await store.loadRun(run.id)).toMatchObject({ status: "paused", error: "operator pause" });
    const pausedResume = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    expect(pausedResume.status).toBe("waiting_approval");

    await cancelWorkflow(run.id, "operator cancel", store);
    expect(await store.loadRun(run.id)).toMatchObject({ status: "cancelled", error: "operator cancel" });
    await expect(resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store })).rejects.toThrow("is cancelled");
  });

  it("invalidates a failed node and downstream nodes for retry", async () => {
    const failing: ToolDefinition = {
      schema: { name: "failing", description: "failing", inputSchema: { type: "object" } },
      execute: vi.fn(async () => ({ output: "bad", isError: true })),
    };
    registry.register(failing);
    const run = await runWorkflow(workflow([
      { id: "first", type: "tool", tool: "failing" },
      { id: "second", type: "agent", agent: "worker", task: "next", dependsOn: ["first"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
    await retryWorkflowNode(run.id, "first", store);

    expect(await store.loadRun(run.id)).toMatchObject({ status: "pending", failedNodeIds: [] });
    expect(await store.loadNode(run.id, "first")).toMatchObject({ status: "pending" });
  });
});
