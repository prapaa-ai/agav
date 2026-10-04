import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { readA2AUsage } from "../agents/a2a-client.js";
import { emptyAgentUsage, type AgentRunResult } from "../agents/executor.js";
import { runWorkflow } from "../workflows/runtime.js";
import { computeRunMetrics } from "../workflows/metrics.js";
import { WorkflowStore } from "../workflows/store.js";
import type { WorkflowDefinition, WorkflowNodeDefinition } from "../workflows/types.js";

class MockProvider implements LLMProvider {
  name = "mock";
  stream = vi.fn((_params: StreamParams) => (async function* () {
    yield { type: "text_delta" as const, text: "ok" };
    yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 };
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

function workflow(nodes: WorkflowNodeDefinition[]): WorkflowDefinition {
  return { version: 1, name: "usage-flow", policies: { sandbox: "none" }, nodes };
}

describe("workflow agent and skill token usage", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;
  let provider: MockProvider;
  // Typed to the signature WorkflowRuntimeDeps declares; an untyped vi.fn() mock is
  // not assignable to it.
  let loadAgent: MockedFunction<(name: string) => Promise<AgentDefinition | null>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-usage-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records usage returned by an agent executor", async () => {
    const executeAgent = vi.fn(async (): Promise<AgentRunResult> => ({
      output: "agent done",
      usage: { inputTokens: 500, outputTokens: 120, cacheReadTokens: 7, cacheWriteTokens: 3 },
    }));

    const run = await runWorkflow(workflow([
      { id: "agent_node", type: "agent", agent: "worker", task: "do work" },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    const node = await store.loadNode(run.id, "agent_node");
    expect(node?.usage).toEqual({ inputTokens: 500, outputTokens: 120, cacheReadTokens: 7, cacheWriteTokens: 3 });
    expect(node?.output).toBe("agent done");
  });

  it("still supports executors that return a plain string", async () => {
    const executeAgent = vi.fn(async () => "legacy string output");

    const run = await runWorkflow(workflow([
      { id: "agent_node", type: "agent", agent: "worker", task: "do work" },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
    const node = await store.loadNode(run.id, "agent_node");
    expect(node?.output).toBe("legacy string output");
    expect(node?.usage).toBeUndefined();
  });

  it("records usage returned by a skill executor", async () => {
    const executeSkill = vi.fn(async () => ({
      output: "skill done",
      usage: { inputTokens: 250, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const run = await runWorkflow(workflow([
      { id: "skill_node", type: "skill", skill: "summarize", args: "text" },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent: async () => "", executeSkill, store });

    expect(run.status).toBe("passed");
    expect(await store.loadNode(run.id, "skill_node")).toMatchObject({
      output: "skill done",
      usage: { inputTokens: 250, outputTokens: 60 },
    });
  });

  it("folds agent usage into run metrics", async () => {
    const executeAgent = vi.fn(async (): Promise<AgentRunResult> => ({
      output: "ok",
      usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const run = await runWorkflow(workflow([
      { id: "a", type: "agent", agent: "worker", task: "one" },
      { id: "b", type: "agent", agent: "worker", task: "two", dependsOn: ["a"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.inputTokens).toBe(800);
    expect(metrics.outputTokens).toBe(200);
    expect(metrics.totalTokens).toBe(1000);
  });

  it("normalizes missing usage fields to zero", async () => {
    const executeAgent = vi.fn(async () => ({ output: "ok", usage: { inputTokens: 10 } as never }));

    const run = await runWorkflow(workflow([
      { id: "a", type: "agent", agent: "worker", task: "one" },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(await store.loadNode(run.id, "a")?.then((node) => node?.usage)).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  describe("readA2AUsage", () => {
    it("returns zeroed usage when metadata is absent", () => {
      expect(readA2AUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      expect(readA2AUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    });

    it("reads usage from a nested usage object", () => {
      expect(readA2AUsage({ usage: { inputTokens: 42, outputTokens: 7 } })).toEqual({
        inputTokens: 42,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it("reads usage from a flat metadata object", () => {
      expect(readA2AUsage({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 })).toEqual({
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 7,
        cacheWriteTokens: 8,
      });
    });

    it("ignores non-numeric values", () => {
      expect(readA2AUsage({ inputTokens: "lots", outputTokens: NaN })).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });

  it("emptyAgentUsage starts at zero", () => {
    expect(emptyAgentUsage()).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
