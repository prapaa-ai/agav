import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
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
  return { version: 1, name: "retry-flow", policies: { sandbox: "none" }, nodes };
}

describe("workflow retry policy", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-retry-policy-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("requires approval before retrying interrupted mutating/unknown tool nodes", async () => {
    const tool: ToolDefinition = {
      schema: { name: "send_email", description: "send", destructive: true, inputSchema: { type: "object" } },
      execute: vi.fn(async () => ({ output: "sent", isError: false })),
    };
    registry.register(tool);

    const run = await runWorkflow(workflow([{ id: "send", type: "tool", tool: "send_email" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    const node = await store.loadNode(run.id, "send");
    await store.saveNode(run.id, { ...node!, status: "running", endedAt: undefined, error: undefined });

    const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(resumed.status).toBe("waiting_approval");
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(await store.loadNode(run.id, "send")).toMatchObject({ status: "waiting_approval", output: "retry_approval_required" });
  });

  it("continues interrupted nodes when retry approval is provided", async () => {
    let calls = 0;
    const tool: ToolDefinition = {
      schema: { name: "send_email", description: "send", destructive: true, inputSchema: { type: "object" } },
      execute: vi.fn(async () => {
        calls++;
        return calls === 1 ? { output: "temporary", isError: true } : { output: "sent", isError: false };
      }),
    };
    registry.register(tool);

    const run = await runWorkflow(workflow([{ id: "send", type: "tool", tool: "send_email" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    const node = await store.loadNode(run.id, "send");
    await store.saveNode(run.id, { ...node!, status: "running", endedAt: undefined, error: undefined });

    const waiting = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    expect(waiting.status).toBe("waiting_approval");

    const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store }, { approveRetry: true });

    expect(resumed.status).toBe("passed");
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });
});
