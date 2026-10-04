import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { resumeWorkflow, runWorkflow , type AgentExecutionOptions} from "../workflows/runtime.js";
import { computeRunMetrics, formatMetrics } from "../workflows/metrics.js";
import { WorkflowStore } from "../workflows/store.js";
import type { WorkflowDefinition, WorkflowNodeDefinition, WorkflowPolicies } from "../workflows/types.js";

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

function workflow(nodes: WorkflowNodeDefinition[], policies: Partial<WorkflowPolicies> = {}): WorkflowDefinition {
  return { version: 1, name: "deadline-flow", policies: { sandbox: "none", ...policies }, nodes };
}

function tool(name: string, execute: { execute: () => Promise<unknown> }["execute"]): any {
  return { schema: { name, description: name, inputSchema: { type: "object" } }, execute };
}

describe("run-level maxRuntimeSeconds", () => {
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
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-deadline-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    provider = new MockProvider();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async () => "ok");
  });

  afterEach(async () => {
    // A run stopped by the ceiling may still have an iteration finishing in the
    // background, which can recreate a checkpoint file as the directory is
    // removed. Retry briefly so cleanup does not race that late write.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  it("stops a run that exceeds maxRuntimeSeconds", async () => {
    registry.register(tool("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { output: "done", isError: false };
    }));

    const run = await runWorkflow(workflow([
      { id: "slow", type: "tool", tool: "slow" },
      { id: "after", type: "tool", tool: "slow", dependsOn: ["slow"] },
    ], { maxRuntimeSeconds: 1 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("timed_out");
    expect(run.error).toContain("maxRuntimeSeconds");

    // The second node never ran.
    expect(await store.loadNode(run.id, "after")).toBeFalsy();
  }, 30_000);

  it("checkpoints the in-flight node as timed_out", async () => {
    registry.register(tool("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { output: "done", isError: false };
    }));

    const run = await runWorkflow(workflow([
      { id: "slow", type: "tool", tool: "slow" },
    ], { maxRuntimeSeconds: 0.05 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("timed_out");
    const node = await store.loadNode(run.id, "slow");
    expect(node?.status).toBe("timed_out");
    expect(node?.error).toContain("maxRuntimeSeconds");
    expect(node?.endedAt).toBeDefined();
  });

  it("caps a single slow node at the remaining run budget", async () => {
    // The node has no timeout of its own; the run ceiling must still apply.
    registry.register(tool("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { output: "done", isError: false };
    }));

    const run = await runWorkflow(workflow([
      { id: "slow", type: "tool", tool: "slow" },
    ], { maxRuntimeSeconds: 0.05 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("timed_out");
    const node = await store.loadNode(run.id, "slow");
    expect(node?.status).toBe("timed_out");
    // The run-level message, not the node-level one.
    expect(node?.error).toContain("maxRuntimeSeconds");
  });

  it("reports a node timeout separately when it fires first", async () => {
    registry.register(tool("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { output: "done", isError: false };
    }));

    const run = await runWorkflow(workflow([
      { id: "slow", type: "tool", tool: "slow", timeoutSeconds: 0.03 },
    ], { maxRuntimeSeconds: 30 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("failed");
    const node = await store.loadNode(run.id, "slow");
    expect(node?.error).toContain("Node timed out after 0.03 seconds");
    expect(node?.error).not.toContain("maxRuntimeSeconds");
  });

  it("leaves an unbounded run alone", async () => {
    registry.register(tool("quick", async () => ({ output: "done", isError: false })));

    const run = await runWorkflow(workflow([
      { id: "a", type: "tool", tool: "quick" },
      { id: "b", type: "tool", tool: "quick", dependsOn: ["a"] },
    ]), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("passed");
  });

  it("ignores a zero or negative limit", async () => {
    registry.register(tool("quick", async () => ({ output: "done", isError: false })));

    for (const limit of [0, -1]) {
      const run = await runWorkflow(workflow([
        { id: "a", type: "tool", tool: "quick" },
      ], { maxRuntimeSeconds: limit }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

      expect(run.status).toBe("passed");
    }
  });

  it("stops a long loop at the run ceiling", async () => {
    let iterations = 0;
    // Cooperate with the abort signal, as a well-behaved tool would, so the run
    // actually stops rather than racing a runaway background loop.
    registry.register({
      schema: { name: "tick", description: "tick", inputSchema: { type: "object" } },
      execute: async (_input, context) => {
        iterations++;
        const signal = context?.signal;
        if (signal?.aborted) return { output: "tick", isError: false };
        // Wake on abort as well as on the timer, so the tool stops promptly
        // instead of finishing in the background after the run has returned.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 40);
          signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        return { output: "tick", isError: false };
      },
    });

    const run = await runWorkflow(workflow([
      { id: "loop", type: "loop", maxIterations: 500, body: [{ id: "tick", type: "tool", tool: "tick" }] },
    ], { maxRuntimeSeconds: 2 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("timed_out");
    // The ceiling bounded the run well short of 500 iterations.
    expect(iterations).toBeLessThan(500);
  }, 30_000);

  it("keeps completed node results so the run is resumable", async () => {
    registry.register(tool("quick", async () => ({ output: "done", isError: false })));
    registry.register(tool("slow", async () => {
      // Long enough that the ceiling always cuts it short, even under load,
      // while the ceiling itself stays generous enough for the quick node to
      // finish. Asserting on a 50ms window made this a timing test.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { output: "done", isError: false };
    }));

    const run = await runWorkflow(workflow([
      { id: "first", type: "tool", tool: "quick" },
      { id: "slow", type: "tool", tool: "slow", dependsOn: ["first"] },
    ], { maxRuntimeSeconds: 0.5 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("timed_out");
    const first = await store.loadNode(run.id, "first");
    expect(first?.status).toBe("passed");
    expect(first?.output).toBe("done");
  });

  it("surfaces the ceiling and overrun in run metrics", async () => {
    registry.register(tool("slow", async () => {
      // Far longer than the ceiling, so the overrun is unambiguous regardless of
      // scheduling or machine load.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { output: "done", isError: false };
    }));

    const run = await runWorkflow(workflow([
      { id: "slow", type: "tool", tool: "slow" },
    ], { maxRuntimeSeconds: 0.5 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    const summary = await store.getRunSummary(run.id);
    const metrics = computeRunMetrics(summary!);

    expect(metrics.maxRuntimeSeconds).toBe(0.5);
    expect(metrics.runtimeExceeded).toBe(true);
    expect(metrics.timedOutNodes).toBe(1);

    const report = formatMetrics(metrics);
    expect(report).toContain("Run exceeded its maxRuntimeSeconds ceiling.");
  });

  it("gives a resumed run a fresh budget rather than inheriting spent time", async () => {
    registry.register(tool("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { output: "done", isError: false };
    }));

    const run = await runWorkflow(workflow([
      { id: "slow", type: "tool", tool: "slow" },
    ], { maxRuntimeSeconds: 0.05 }), {}, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });

    expect(run.status).toBe("timed_out");

    // A later resume with a generous limit can continue past the old ceiling.
    const resumed = await resumeWorkflow(run.id, { provider, config, toolRegistry: registry, loadAgent, executeAgent, store });
    expect(resumed.status).not.toBe("timed_out");
  });
});
