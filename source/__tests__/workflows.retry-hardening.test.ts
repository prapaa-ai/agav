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
import { backoffDelayMs, effectiveCrashAttempts, effectiveMaxAttempts, resolveRetryDecision, shouldRetryNode } from "../workflows/retry.js";
import { resumeWorkflow, runWorkflow, type AgentExecutionOptions } from "../workflows/runtime.js";
import { WorkflowStore } from "../workflows/store.js";
import type { WorkflowDefinition, WorkflowNodeDefinition, WorkflowNodeRun } from "../workflows/types.js";

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

function workflow(nodes: WorkflowNodeDefinition[]): WorkflowDefinition {
  return { version: 1, name: "retry-flow", policies: { sandbox: "none" }, nodes };
}

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { schema: { name, description: name, inputSchema: { type: "object" } }, execute };
}

function nodeRun(partial: Partial<WorkflowNodeRun>): WorkflowNodeRun {
  return { id: "n", type: "tool", status: "failed", attempt: 1, nodeHash: "h", ...partial };
}

describe("workflow retry hardening", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-retry-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async (_agent: AgentDefinition, task: string) => `agent output ${task}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("resolveRetryDecision", () => {
    it("executes a first attempt", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t" },
        attempt: 1,
        previous: null,
        approveRetry: false,
        dryRun: false,
      });
      expect(decision).toEqual({ action: "execute" });
    });

    it("reuses a node that already passed", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t" },
        attempt: 1,
        previous: nodeRun({ status: "passed" }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision.action).toBe("reuse");
    });

    it("does not retry a failure when retryOnFailure is not set", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t" },
        attempt: 2,
        previous: nodeRun({ status: "failed", attempt: 1 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision.action).toBe("reuse");
    });

    it("retries a failure when retryOnFailure is enabled", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t", retryPolicy: { retryOnFailure: true, maxAttempts: 3 } },
        attempt: 2,
        previous: nodeRun({ status: "failed", attempt: 1 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision).toEqual({ action: "execute" });
    });

    it("reports exhaustion once maxAttempts is reached", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t", retryPolicy: { retryOnFailure: true, maxAttempts: 2 } },
        attempt: 3,
        previous: nodeRun({ status: "failed", attempt: 2 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision.action).toBe("exhausted");
    });

    it("honours nonRetryableStatuses", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t", retryPolicy: { retryOnFailure: true, maxAttempts: 5, nonRetryableStatuses: ["cancelled"] } },
        attempt: 2,
        previous: nodeRun({ status: "cancelled", attempt: 1 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision.action).toBe("exhausted");
    });

    it("never retries during a dry run", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t", retryPolicy: { retryOnFailure: true, maxAttempts: 5 } },
        attempt: 2,
        previous: nodeRun({ status: "failed", attempt: 1 }),
        approveRetry: false,
        dryRun: true,
      });
      expect(decision.action).toBe("reuse");
    });

    it("waits for approval on an interrupted mutating node", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t" },
        attempt: 2,
        previous: nodeRun({ status: "running", attempt: 1 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision.action).toBe("wait_approval");
    });

    it("recovers an interrupted node without approval when retrySafe", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t", retrySafe: true },
        attempt: 2,
        previous: nodeRun({ status: "running", attempt: 1 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision).toEqual({ action: "execute" });
    });

    it("always executes a node that an operator reset to pending", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t" },
        attempt: 7,
        previous: nodeRun({ status: "pending", attempt: 6 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision).toEqual({ action: "execute" });
    });

    it("always re-evaluates a waiting approval node", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "approval", prompt: "ok?" },
        attempt: 2,
        previous: nodeRun({ status: "waiting_approval", attempt: 1 }),
        approveRetry: false,
        dryRun: false,
      });
      expect(decision).toEqual({ action: "execute" });
    });

    it("clears a pending retry approval once approved", () => {
      const decision = resolveRetryDecision({
        node: { id: "n", type: "tool", tool: "t" },
        attempt: 2,
        previous: nodeRun({ status: "waiting_approval", output: "retry_approval_required", attempt: 1 }),
        approveRetry: true,
        dryRun: false,
      });
      expect(decision).toEqual({ action: "execute" });
    });
  });

  describe("budgets and backoff", () => {
    it("defaults maxAttempts to 1 (no automatic retry)", () => {
      expect(effectiveMaxAttempts({ id: "n", type: "tool", tool: "t" })).toBe(1);
    });

    it("uses an explicit maxAttempts", () => {
      expect(effectiveMaxAttempts({ id: "n", type: "tool", tool: "t", retryPolicy: { maxAttempts: 5 } })).toBe(5);
    });

    it("allows crash recovery by default even when failure retry is off", () => {
      expect(effectiveCrashAttempts({ id: "n", type: "tool", tool: "t" })).toBe(2);
    });

    it("only reports retryable nodes", () => {
      expect(shouldRetryNode({ id: "n", type: "tool", tool: "t" })).toBe(false);
      expect(shouldRetryNode({ id: "n", type: "tool", tool: "t", retryPolicy: { retryOnFailure: true } })).toBe(true);
      expect(shouldRetryNode({ id: "n", type: "tool", tool: "t", retryPolicy: { maxAttempts: 3 } })).toBe(true);
    });

    it("computes exponential backoff capped by maxDelayMs", () => {
      const policy = { initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 250 };
      expect(backoffDelayMs(policy, 1)).toBe(100);
      expect(backoffDelayMs(policy, 2)).toBe(200);
      expect(backoffDelayMs(policy, 3)).toBe(250);
    });

    it("returns zero backoff when not configured", () => {
      expect(backoffDelayMs(undefined, 3)).toBe(0);
      expect(backoffDelayMs({ maxAttempts: 3 }, 3)).toBe(0);
    });
  });

  describe("runtime integration", () => {
    it("automatically retries a failure until it succeeds", async () => {
      let calls = 0;
      registry.register(tool("flaky", async () => {
        calls++;
        return calls < 3 ? { output: "bad", isError: true } : { output: "good", isError: false };
      }));

      const run = await runWorkflow(workflow([
        { id: "f", type: "tool", tool: "flaky", retryPolicy: { retryOnFailure: true, maxAttempts: 5 } },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("passed");
      expect(calls).toBe(3);
      const attempts = await store.listNodeAttempts(run.id, "f");
      expect(attempts.map((a) => a.status)).toEqual(["failed", "failed", "passed"]);
    });

    it("stops retrying once maxAttempts is exhausted", async () => {
      let calls = 0;
      registry.register(tool("always_bad", async () => {
        calls++;
        return { output: "bad", isError: true };
      }));

      const run = await runWorkflow(workflow([
        { id: "f", type: "tool", tool: "always_bad", retryPolicy: { retryOnFailure: true, maxAttempts: 3 } },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("failed");
      expect(calls).toBe(3);
      expect(await store.listNodeAttempts(run.id, "f")).toHaveLength(3);
    });

    it("does not retry a failure when retries are not enabled", async () => {
      let calls = 0;
      registry.register(tool("always_bad", async () => {
        calls++;
        return { output: "bad", isError: true };
      }));

      const run = await runWorkflow(workflow([{ id: "f", type: "tool", tool: "always_bad" }]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("failed");
      expect(calls).toBe(1);
    });

    it("applies backoff between retries", async () => {
      let calls = 0;
      const started = Date.now();
      registry.register(tool("flaky", async () => {
        calls++;
        return calls < 2 ? { output: "bad", isError: true } : { output: "good", isError: false };
      }));

      const run = await runWorkflow(workflow([
        { id: "f", type: "tool", tool: "flaky", retryPolicy: { retryOnFailure: true, maxAttempts: 3, initialDelayMs: 60 } },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("passed");
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    });

    it("still allows an operator reset after retries are exhausted", async () => {
      let calls = 0;
      registry.register(tool("flaky", async () => {
        calls++;
        return calls < 2 ? { output: "bad", isError: true } : { output: "good", isError: false };
      }));

      const run = await runWorkflow(workflow([
        { id: "f", type: "tool", tool: "flaky", retryPolicy: { retryOnFailure: true, maxAttempts: 1 } },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("failed");
      expect(calls).toBe(1);

      await retryWorkflowNode(run.id, "f", store);
      const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(resumed.status).toBe("passed");
      expect(calls).toBe(2);
    });

    it("retries a timed out node when retries are enabled", async () => {
      let calls = 0;
      registry.register(tool("hangs", async () => {
        calls++;
        // Only the first attempt stalls; every retry after that returns fast.
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 80));
        return { output: "result", isError: false };
      }));

      const run = await runWorkflow(workflow([
        { id: "h", type: "tool", tool: "hangs", timeoutSeconds: 0.03, retryPolicy: { retryOnFailure: true, maxAttempts: 3 } },
      ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("passed");
      const attempts = await store.listNodeAttempts(run.id, "h");
      expect(attempts[0]?.status).toBe("timed_out");
      expect(attempts[attempts.length - 1]?.status).toBe("passed");
    });
  });
});
