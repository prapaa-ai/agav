import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { retryWorkflowNode } from "../workflows/control.js";
import { resumeWorkflow, runWorkflow, type AgentExecutionOptions } from "../workflows/runtime.js";
import { computeRunMetrics, formatDuration, formatMetrics, nodeDurationMs } from "../workflows/metrics.js";
import { WorkflowStore } from "../workflows/store.js";
import type { WorkflowDefinition, WorkflowNodeDefinition } from "../workflows/types.js";

class MockProvider implements LLMProvider {
  name = "mock";
  stream = vi.fn((_params: StreamParams) => (async function* () {
    yield { type: "text_delta" as const, text: "ok" };
    yield { type: "usage" as const, inputTokens: 120, outputTokens: 40 };
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
  return { version: 1, name: "metrics-flow", policies: { sandbox: "none" }, nodes };
}

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { schema: { name, description: name, inputSchema: { type: "object" } }, execute };
}

describe("workflow observability", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-metrics-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("computes node counts by status", async () => {
    registry.register(tool("good", async () => ({ output: "ok", isError: false })));
    registry.register(tool("bad", async () => ({ output: "boom", isError: true })));

    const run = await runWorkflow(workflow([
      { id: "ok_node", type: "tool", tool: "good" },
      { id: "bad_node", type: "tool", tool: "bad" },
      { id: "later", type: "tool", tool: "good", dependsOn: ["bad_node"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.nodeCount).toBe(2);
    expect(metrics.completedNodes).toBe(1);
    expect(metrics.failedNodes).toBe(1);
    expect(metrics.pendingNodes).toBe(1);
    expect(metrics.timedOutNodes).toBe(0);
  });

  it("aggregates token usage across nodes", async () => {
    const run = await runWorkflow(workflow([
      { id: "p1", type: "prompt", prompt: "one" },
      { id: "p2", type: "prompt", prompt: "two", dependsOn: ["p1"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.inputTokens).toBe(240);
    expect(metrics.outputTokens).toBe(80);
    expect(metrics.totalTokens).toBe(320);
  });

  it("reports attempts and retried nodes", async () => {
    let calls = 0;
    registry.register(tool("flaky", async () => {
      calls++;
      return calls === 1 ? { output: "bad", isError: true } : { output: "good", isError: false };
    }));

    const run = await runWorkflow(workflow([{ id: "f", type: "tool", tool: "flaky", retrySafe: true }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    await retryWorkflowNode(run.id, "f", store);
    await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.maxAttempts).toBe(2);
    expect(metrics.totalAttempts).toBe(2);
    expect(metrics.retriedNodes).toEqual([{ nodeId: "f", attempts: 2 }]);
  });

  it("counts dry-run and mocked nodes", async () => {
    const run = await runWorkflow(workflow([
      { id: "skipped", type: "agent", agent: "unmocked", task: "do work" },
      { id: "mocked", type: "agent", agent: "mocked_agent", task: "mocked work", dependsOn: ["skipped"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store }, {
      dryRun: true,
      mocks: { agents: { mocked_agent: { result: "mocked" } } },
    });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.dryRunNodes).toBe(2);
    expect(metrics.mockedNodes).toBe(1);
    expect(metrics.skippedNodes).toBe(1);
  });

  it("breaks duration down by node type and finds the slowest nodes", async () => {
    const slow = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { output: "slow", isError: false };
    });
    registry.register(tool("slow", slow));
    registry.register(tool("fast", async () => ({ output: "fast", isError: false })));

    const run = await runWorkflow(workflow([
      { id: "slow_node", type: "tool", tool: "slow" },
      { id: "fast_node", type: "tool", tool: "fast", dependsOn: ["slow_node"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.byType[0]).toMatchObject({ type: "tool", count: 2, failed: 0 });
    expect(metrics.slowestNodes[0].id).toBe("slow_node");
    expect(metrics.durationMs).toBeGreaterThan(0);
  });

  it("counts timed out nodes as failures", async () => {
    registry.register(tool("hangs", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { output: "late", isError: false };
    }));

    const run = await runWorkflow(workflow([{ id: "h", type: "tool", tool: "hangs", timeoutSeconds: 0.001 }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.timedOutNodes).toBe(1);
    expect(metrics.failedNodes).toBe(1);
  });

  it("reports real elapsed time per node rather than a zero window", async () => {
    const slow = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { output: "done", isError: false };
    });
    registry.register(tool("slow", slow));

    const run = await runWorkflow(workflow([{ id: "slow_node", type: "tool", tool: "slow" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const node = await store.loadNode(run.id, "slow_node");
    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    // The node ran for at least 60ms, so its checkpoint must show that.
    expect(nodeDurationMs(node!)).toBeGreaterThanOrEqual(50);
    expect(metrics.byType[0].durationMs).toBeGreaterThanOrEqual(50);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(50);
  });

  it("formats durations at multiple scales", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });

  it("computes node duration from start and end timestamps", () => {
    const node = {
      id: "n",
      type: "tool" as const,
      status: "passed" as const,
      attempt: 1,
      nodeHash: "h",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:02.500Z",
    };
    expect(nodeDurationMs(node)).toBe(2500);
  });

  it("uses the current time for nodes that are still running", () => {
    const node = {
      id: "n",
      type: "tool" as const,
      status: "running" as const,
      attempt: 1,
      nodeHash: "h",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const now = new Date("2026-01-01T00:00:03.000Z");
    expect(nodeDurationMs(node, now)).toBe(3000);
  });

  it("renders a metrics report with usage, attempts and timing", async () => {
    registry.register(tool("ok", async () => ({ output: "ok", isError: false })));

    const run = await runWorkflow(workflow([{ id: "step", type: "tool", tool: "ok" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const report = formatMetrics(computeRunMetrics(summary!));

    expect(report).toContain(`Metrics for ${run.id}`);
    expect(report).toContain("Nodes:");
    expect(report).toContain("Tokens:");
    expect(report).toContain("Attempts:");
    expect(report).toContain("By node type:");
    expect(report).toContain("Slowest nodes:");
  });

  it("reads back per-node and per-run logs", async () => {
    registry.register(tool("ok", async () => ({ output: "ok", isError: false })));

    const run = await runWorkflow(workflow([{ id: "logged", type: "tool", tool: "ok" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const nodeLogs = await store.readLog(run.id, "logged", 10);
    expect(nodeLogs.length).toBeGreaterThan(0);
    expect(nodeLogs.some((line) => line.includes("node_started"))).toBe(true);

    const runLogs = await store.readRunLogs(run.id, 10);
    expect(runLogs.some((entry) => entry.nodeId === "logged")).toBe(true);
  });

  it("returns empty logs for unknown nodes instead of throwing", async () => {
    expect(await store.readLog("run_missing", "node", 10)).toEqual([]);
    expect(await store.readRunLogs("run_missing", 10)).toEqual([]);
  });
});
