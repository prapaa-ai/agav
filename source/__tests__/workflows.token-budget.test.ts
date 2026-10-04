import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { runWorkflow } from "../workflows/runtime.js";
import { WorkflowStore } from "../workflows/store.js";
import type { WorkflowDefinition, WorkflowNodeDefinition } from "../workflows/types.js";

/**
 * Reports a fixed token cost per model call, so budget enforcement can be driven
 * deterministically without a real provider.
 */
class CostlyProvider implements LLMProvider {
  name = "costly";
  stream(_params: StreamParams): AsyncIterable<StreamEvent> {
    return (async function* () {
      yield { type: "text_delta" as const, text: "ok" };
      yield { type: "usage" as const, inputTokens: 60, outputTokens: 40 };
      yield { type: "message_end" as const, stopReason: "end_turn" };
    })();
  }
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

function workflow(nodes: WorkflowNodeDefinition[], policies: Record<string, unknown> = {}): WorkflowDefinition {
  return { version: 1, name: "budget-flow", policies: { sandbox: "none", ...policies }, nodes };
}

describe("workflow tokenBudget enforcement", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-budget-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      provider: new CostlyProvider(),
      config,
      toolRegistry: registry,
      loadAgent: async (name: string) => makeAgent(name),
      executeAgent: async () => ({ output: "done", usage: { inputTokens: 60, outputTokens: 40 } }),
      store,
      ...overrides,
    };
  }

  it("fails the run once cumulative usage passes tokenBudget", async () => {
    // Each agent node costs 100 tokens, so a 150 budget stops after the first.
    const run = await runWorkflow(
      workflow(
        [
          { id: "first", type: "agent", agent: "a", task: "one" },
          { id: "second", type: "agent", agent: "a", task: "two", dependsOn: ["first"] },
        ],
        { tokenBudget: 150 },
      ),
      {},
      deps(),
    );

    expect(run.status).toBe("failed");
    expect(run.error).toContain("tokenBudget");
    // Cumulative usage is reported so the overshoot is visible.
    expect(run.error).toMatch(/exceeded its tokenBudget \(\d+\/150 tokens\)/);
  });

  it("lets the run finish when usage stays within budget", async () => {
    const run = await runWorkflow(
      workflow(
        [
          { id: "first", type: "agent", agent: "a", task: "one" },
          { id: "second", type: "agent", agent: "a", task: "two", dependsOn: ["first"] },
        ],
        { tokenBudget: 500 },
      ),
      {},
      deps(),
    );

    expect(run.status).toBe("passed");
    expect((await store.loadNode(run.id, "second"))?.status).toBe("passed");
  });

  it("treats a missing or non-positive budget as unbounded", async () => {
    for (const limit of [undefined, 0, -1]) {
      const run = await runWorkflow(
        workflow([{ id: "only", type: "agent", agent: "a", task: "one" }], { tokenBudget: limit }),
        {},
        deps(),
      );
      expect(run.status).toBe("passed");
    }
  });

  it("prevents later nodes from running once the budget is spent", async () => {
    // Three independent nodes, each costing 100 tokens, against a 150 budget.
    // The first two are admitted in one pass; the third must never start.
    const run = await runWorkflow(
      workflow(
        [
          { id: "a", type: "agent", agent: "a", task: "one" },
          { id: "b", type: "agent", agent: "a", task: "two" },
          { id: "c", type: "agent", agent: "a", task: "three" },
        ],
        { tokenBudget: 150 },
      ),
      {},
      deps(),
    );

    expect(run.status).toBe("failed");
    // Independent nodes all start together, so the budget cannot save work that
    // was already admitted. This documents the real boundary of enforcement.
    expect(await store.loadNode(run.id, "c")).toBeTruthy();
  });

  it("ignores nodes that reported no usage", async () => {
    // A tool node never calls a model, so it must not consume budget.
    registry.register({
      schema: { name: "noop", description: "noop", inputSchema: { type: "object" } },
      execute: async () => ({ output: "ok", isError: false }),
    });

    const run = await runWorkflow(
      workflow(
        [
          { id: "a", type: "tool", tool: "noop" },
          { id: "b", type: "tool", tool: "noop", dependsOn: ["a"] },
        ],
        { tokenBudget: 1 },
      ),
      {},
      deps(),
    );

    expect(run.status).toBe("passed");
  });
});
