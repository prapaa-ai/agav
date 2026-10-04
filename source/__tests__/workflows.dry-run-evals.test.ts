import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { runWorkflow , type AgentExecutionOptions} from "../workflows/runtime.js";
import { WorkflowStore } from "../workflows/store.js";
import { loadWorkflowEvals, runWorkflowEvals } from "../workflows/evals.js";
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
  return { version: 1, name: "dry-run-flow", policies: { sandbox: "none" }, nodes };
}

describe("workflow dry-run and evals", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-dry-run-"));
    store = new WorkflowStore({ rootDir: join(dir, "runs") });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("skips agent nodes in dry-run mode without side effects", async () => {
    const run = await runWorkflow(workflow([
      { id: "draft", type: "agent", agent: "ezisign_agent", task: "send envelope" },
      { id: "approve", type: "approval", prompt: "approve?", dependsOn: ["draft"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store }, { dryRun: true });

    expect(run.status).toBe("passed");
    expect(executeAgent).not.toHaveBeenCalled();
    expect(await store.loadNode(run.id, "draft")).toMatchObject({ status: "skipped", dryRun: true });
    expect(await store.loadNode(run.id, "approve")).toMatchObject({ status: "passed", dryRun: true, approval: { decision: "approved" } });
  });

  it("uses mocks to pass dry-run agent outputs to downstream checks", async () => {
    const run = await runWorkflow(workflow([
      { id: "list_pending", type: "agent", agent: "ezisign_agent", task: "list pending" },
      { id: "assert", type: "test", dependsOn: ["list_pending"], assertions: [{ type: "output_contains", node: "list_pending", value: "env_1" }] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store }, {
      dryRun: true,
      mocks: { agents: { ezisign_agent: { envelopes: [{ id: "env_1" }] } } },
    });

    expect(run.status).toBe("passed");
    expect(await store.loadNode(run.id, "list_pending")).toMatchObject({ status: "passed", mocked: true, dryRun: true });
  });

  it("skips unsafe tool nodes but runs dry-run safe tools", async () => {
    const safeTool: ToolDefinition = {
      schema: { name: "read_file", description: "read", inputSchema: { type: "object" } },
      execute: vi.fn(async () => ({ output: "safe output", isError: false })),
    };
    const unsafeTool: ToolDefinition = {
      schema: { name: "send_email", description: "send", destructive: true, inputSchema: { type: "object" } },
      execute: vi.fn(async () => ({ output: "sent", isError: false })),
    };
    registry.register(safeTool);
    registry.register(unsafeTool);

    const run = await runWorkflow(workflow([
      { id: "safe", type: "tool", tool: "read_file", input: { path: "a.txt" } },
      { id: "unsafe", type: "tool", tool: "send_email", input: { to: "a@example.com" }, dependsOn: ["safe"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store }, { dryRun: true });

    expect(run.status).toBe("passed");
    expect(safeTool.execute).toHaveBeenCalledTimes(1);
    expect(unsafeTool.execute).not.toHaveBeenCalled();
    expect(await store.loadNode(run.id, "unsafe")).toMatchObject({ status: "skipped", dryRun: true });
  });

  it("loads and runs workflow eval fixtures", async () => {
    const workflowPath = join(dir, "sample.yaml");
    const evalDir = join(dir, "sample.evals");
    await writeFile(workflowPath, "unused");
    await mkdir(evalDir);
    await writeFile(join(evalDir, "happy.json"), JSON.stringify({
      name: "happy",
      mocks: { agents: { ezisign_agent: { envelopes: [{ id: "env_1" }] } } },
      expect: { status: "passed", nodes: { list_pending: "passed", assert: "passed" }, outputContains: { list_pending: "env_1" } },
    }));

    const fixtures = await loadWorkflowEvals(workflowPath);
    const summary = await runWorkflowEvals(workflow([
      { id: "list_pending", type: "agent", agent: "ezisign_agent", task: "list" },
      { id: "assert", type: "test", dependsOn: ["list_pending"], assertions: [{ type: "output_contains", node: "list_pending", value: "env_1" }] },
    ]), fixtures, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(fixtures).toHaveLength(1);
    expect(summary).toMatchObject({ passed: true, total: 1, passedCount: 1, failedCount: 0 });
  });
});
