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

class MockProvider implements LLMProvider {
  name = "mock";
  stream(_params: StreamParams): AsyncIterable<StreamEvent> {
    return (async function* () {
      yield { type: "text_delta" as const, text: "ok" };
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

function workflow(nodes: WorkflowNodeDefinition[]): WorkflowDefinition {
  return { version: 1, name: "dark-factory", policies: { sandbox: "none" }, nodes };
}

describe("workflow when conditions", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-when-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Registers a tool returning a fixed payload, so a condition can read it. */
  function probe(name: string, payload: Record<string, unknown>) {
    registry.register({
      schema: { name, description: name, inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: JSON.stringify(payload), isError: false }),
    });
    return name;
  }

  function deps() {
    return {
      provider: new MockProvider(),
      config,
      toolRegistry: registry,
      loadAgent: async (name: string) => makeAgent(name),
      executeAgent: async () => "ok",
      store,
    };
  }

  it("runs a node when its condition holds", async () => {
    probe("triage", { severity: "high" });
    registry.register({
      schema: { name: "fix", description: "fix", inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: "fixed", isError: false }),
    });

    const run = await runWorkflow(workflow([
      { id: "triage", type: "tool", tool: "triage" },
      { id: "fix", type: "tool", tool: "fix", dependsOn: ["triage"], when: '${nodes.triage.output.severity} == "high"' },
    ]), {}, deps());

    expect(run.status).toBe("passed");
    expect((await store.loadNode(run.id, "fix"))?.status).toBe("passed");
  });

  it("skips a node when its condition fails, and records why", async () => {
    probe("triage", { severity: "low" });
    registry.register({
      schema: { name: "page", description: "page", inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: "paged", isError: false }),
    });

    const run = await runWorkflow(workflow([
      { id: "triage", type: "tool", tool: "triage" },
      { id: "page", type: "tool", tool: "page", dependsOn: ["triage"], when: '${nodes.triage.output.severity} == "high"' },
    ]), {}, deps());

    const page = await store.loadNode(run.id, "page");
    expect(page?.status).toBe("skipped");
    expect(page?.skippedReason).toContain("Condition not met");
    // The skipped node must not have executed its side effect.
    expect(page?.output).toMatchObject({ skipped: true });
  });

  it("does not deadlock when a skipped node gates another node", async () => {
    probe("triage", { severity: "low" });
    probe("page", { paged: true });
    registry.register({
      schema: { name: "audit", description: "audit", inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: "audited", isError: false }),
    });

    // `page` is skipped by its condition, and `audit` depends on it. If a
    // skipped dependency did not satisfy readiness, the run would hang here.
    const run = await runWorkflow(workflow([
      { id: "triage", type: "tool", tool: "triage" },
      { id: "page", type: "tool", tool: "page", dependsOn: ["triage"], when: '${nodes.triage.output.severity} == "high"' },
      { id: "audit", type: "tool", tool: "audit", dependsOn: ["page"] },
    ]), {}, deps());

    expect(run.status).toBe("passed");
    expect((await store.loadNode(run.id, "audit"))?.status).toBe("passed");
  });

  it("lets a dependent decide for itself against a skipped result", async () => {
    probe("triage", { severity: "low" });
    probe("page", { paged: true });
    registry.register({
      schema: { name: "audit", description: "audit", inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: "audited", isError: false }),
    });

    // `audit` has its own condition, so it must be evaluated rather than
    // auto-satisfied by the skipped dependency.
    const run = await runWorkflow(workflow([
      { id: "triage", type: "tool", tool: "triage" },
      { id: "page", type: "tool", tool: "page", dependsOn: ["triage"], when: '${nodes.triage.output.severity} == "high"' },
      { id: "audit", type: "tool", tool: "audit", dependsOn: ["page"], when: "${nodes.triage.output.severity} == \"low\"" },
    ]), {}, deps());

    expect(run.status).toBe("passed");
    expect((await store.loadNode(run.id, "audit"))?.status).toBe("passed");
  });

  it("reads run inputs", async () => {
    registry.register({
      schema: { name: "notify", description: "notify", inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: "notified", isError: false }),
    });

    const run = await runWorkflow(workflow([
      { id: "notify", type: "tool", tool: "notify", when: '${inputs.notify} == "yes"' },
    ]), { notify: "yes" }, deps());

    expect((await store.loadNode(run.id, "notify"))?.status).toBe("passed");
  });

  it("keeps a skipped node skipped across a resume", async () => {
    probe("triage", { severity: "low" });
    registry.register({
      schema: { name: "page", description: "page", inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: "paged", isError: false }),
    });

    const def = workflow([
      { id: "triage", type: "tool", tool: "triage" },
      { id: "page", type: "tool", tool: "page", dependsOn: ["triage"], when: '${nodes.triage.output.severity} == "high"' },
    ]);

    const run = await runWorkflow(def, {}, deps());
    expect((await store.loadNode(run.id, "page"))?.status).toBe("skipped");

    const { resumeWorkflow } = await import("../workflows/runtime.js");
    const resumed = await resumeWorkflow(run.id, deps());

    expect(resumed.status).toBe("passed");
    // The decision is durable, so the branch is not re-evaluated into a run.
    expect((await store.loadNode(run.id, "page"))?.status).toBe("skipped");
  });
});
