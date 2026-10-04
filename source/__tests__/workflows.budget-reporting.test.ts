import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import {
  formatA2ATokenBudget,
  hasA2AUsage,
  readA2ATokenBudget,
  readA2AUsage,
} from "../agents/a2a-client.js";
import { runWorkflow } from "../workflows/runtime.js";
import { computeRunMetrics, formatMetrics } from "../workflows/metrics.js";
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

function workflow(nodes: WorkflowNodeDefinition[]): WorkflowDefinition {
  return { version: 1, name: "budget-flow", policies: { sandbox: "none" }, nodes };
}

function externalAgent(): AgentDefinition {
  return {
    manifest: { name: "remote", description: "remote", version: "1.0.0", type: "a2a" },
    systemPrompt: "",
    tools: [],
    origin: "project",
    path: process.cwd(),
  } as AgentDefinition;
}

describe("external agent token budget reporting", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;
  let provider: MockProvider;
  // Typed to the signature WorkflowRuntimeDeps declares; an untyped vi.fn() mock is
  // not assignable to it.
  let loadAgent: MockedFunction<(name: string) => Promise<AgentDefinition | null>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-budget-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async () => externalAgent());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("readA2ATokenBudget", () => {
    it("returns undefined when the agent reports no budget", () => {
      expect(readA2ATokenBudget(undefined)).toBeUndefined();
      expect(readA2ATokenBudget({})).toBeUndefined();
      expect(readA2ATokenBudget({ output: "done" })).toBeUndefined();
    });

    it("reads a full budget", () => {
      const budget = readA2ATokenBudget({
        tokenBudget: { limit: 1000, used: 250, remaining: 750, period: "run" },
      });
      expect(budget).toEqual({ limit: 1000, used: 250, remaining: 750, period: "run" });
    });

    it("reads partial budgets", () => {
      expect(readA2ATokenBudget({ tokenBudget: { limit: 500 } })).toEqual({ limit: 500 });
      expect(readA2ATokenBudget({ tokenBudget: { remaining: 10 } })).toEqual({ remaining: 10 });
    });

    it("accepts alternative field names", () => {
      expect(readA2ATokenBudget({ tokenBudget: { maxTokens: 42 } })).toEqual({ limit: 42 });
      expect(readA2ATokenBudget({ tokenBudget: { consumed: 7 } })).toEqual({ used: 7 });
      expect(readA2ATokenBudget({ tokenBudget: { left: 3 } })).toEqual({ remaining: 3 });
    });

    it("ignores malformed values instead of reporting garbage", () => {
      expect(readA2ATokenBudget({ tokenBudget: { limit: "lots", used: NaN } })).toBeUndefined();
    });

    it("treats a budget object with no usable numbers as no budget", () => {
      expect(readA2ATokenBudget({ tokenBudget: { period: "day" } })).toBeUndefined();
    });
  });

  describe("hasA2AUsage", () => {
    it("distinguishes an unreported usage from a reported zero", () => {
      expect(hasA2AUsage(undefined)).toBe(false);
      expect(hasA2AUsage({})).toBe(false);
      expect(hasA2AUsage({ output: "text" })).toBe(false);
      expect(hasA2AUsage({ usage: { inputTokens: 0, outputTokens: 0 } })).toBe(true);
    });

    it("does not mistake unrelated metadata for usage", () => {
      expect(hasA2AUsage({ tokenBudget: { limit: 10 }, sessionId: "abc" })).toBe(false);
    });

    it("still reads usage from flat metadata", () => {
      expect(hasA2AUsage({ inputTokens: 5, outputTokens: 6 })).toBe(true);
      expect(readA2AUsage({ inputTokens: 5, outputTokens: 6 })).toEqual({
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });
  });

  describe("formatA2ATokenBudget", () => {
    it("flags a missing budget explicitly", () => {
      expect(formatA2ATokenBudget(undefined)).toBe("No token budget returned");
      expect(formatA2ATokenBudget({})).toBe("No token budget returned");
    });

    it("renders the reported budget", () => {
      expect(formatA2ATokenBudget({ limit: 100, used: 20, remaining: 80, period: "day" }))
        .toBe("limit 100, used 20, remaining 80 (day)");
    });
  });

  describe("workflow checkpoints", () => {
    it("stores a reported budget and marks usage as reported", async () => {
      const executeAgent = vi.fn(async () => ({
        output: "remote output",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageReported: true,
        tokenBudget: { limit: 5000, used: 120, remaining: 4880, period: "run" },
      }));

      const run = await runWorkflow(workflow([
        { id: "remote_call", type: "agent", agent: "remote", task: "fetch" },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("passed");
      const node = await store.loadNode(run.id, "remote_call");
      expect(node?.usageReported).toBe(true);
      expect(node?.tokenBudget).toEqual({ limit: 5000, used: 120, remaining: 4880, period: "run" });
      expect(node?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    });

    it("marks a missing budget and missing usage explicitly", async () => {
      const executeAgent = vi.fn(async () => ({
        output: "remote output",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageReported: false,
      }));

      const run = await runWorkflow(workflow([
        { id: "remote_call", type: "agent", agent: "remote", task: "fetch" },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      const node = await store.loadNode(run.id, "remote_call");
      expect(node?.usageReported).toBe(false);
      expect(node?.tokenBudget).toBeUndefined();
    });
  });

  describe("metrics reporting", () => {
    it("shows a reported budget", async () => {
      const executeAgent = vi.fn(async () => ({
        output: "ok",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageReported: true,
        tokenBudget: { limit: 200, used: 12, period: "day" },
      }));

      const run = await runWorkflow(workflow([
        { id: "remote_call", type: "agent", agent: "remote", task: "fetch" },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      const summary = await store.getRunSummary(run.id);
      const metrics = computeRunMetrics(summary!);

      expect(metrics.reportedBudgets).toEqual([{ nodeId: "remote_call", limit: 200, used: 12, period: "day" }]);
      expect(metrics.unreportedUsageNodes).toEqual([]);

      const report = formatMetrics(metrics);
      expect(report).toContain("External agent budgets:");
      expect(report).toContain("limit 200, used 12 (day)");
    });

    it("highlights an external agent that returned no budget", async () => {
      const executeAgent = vi.fn(async () => ({
        output: "ok",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        usageReported: false,
      }));

      const run = await runWorkflow(workflow([
        { id: "remote_call", type: "agent", agent: "remote", task: "fetch" },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      const summary = await store.getRunSummary(run.id);
      const metrics = computeRunMetrics(summary!);

      expect(metrics.unreportedUsageNodes).toEqual(["remote_call"]);
      expect(metrics.reportedBudgets).toEqual([]);

      const report = formatMetrics(metrics);
      expect(report).toContain("No token budget returned by external agents:");
      expect(report).toContain("remote_call");
    });

    it("does not flag in-process agents that report no budget", async () => {
      const executeAgent = vi.fn(async () => "local output");

      const run = await runWorkflow(workflow([
        { id: "local_call", type: "agent", agent: "local", task: "compute" },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      const summary = await store.getRunSummary(run.id);
      const metrics = computeRunMetrics(summary!);

      // A plain string result carries no usageReported flag, so the node is not
      // treated as a silent external agent.
      expect(metrics.unreportedUsageNodes).toEqual([]);
    });
  });
});
