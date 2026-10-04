import { afterEach, beforeEach, describe, expect, it, vi , type MockedFunction} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { createRunController, resumeWorkflow, runWorkflow , type AgentExecutionOptions} from "../workflows/runtime.js";
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
  return { version: 1, name: "shutdown-flow", policies: { sandbox: "none" }, nodes };
}

/**
 * Build a deps object for the runtime. The mock parameters are typed to match the
 * declarations above, so the returned object satisfies WorkflowRuntimeDeps.
 */
function depsFor(
  store: WorkflowStore,
  registry: ToolRegistry,
  loadAgent: MockedFunction<(name: string) => Promise<AgentDefinition | null>>,
  executeAgent: MockedFunction<
    (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string>
  >,
) {
  return { provider: new MockProvider(), config, toolRegistry: registry, loadAgent, executeAgent, store };
}

describe("clean shutdown and restart", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;
  // Typed to the signatures WorkflowRuntimeDeps declares. An untyped vi.fn() mock is
  // not assignable to those.
  let loadAgent: MockedFunction<(name: string) => Promise<AgentDefinition | null>>;
  let executeAgent: MockedFunction<
    (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string>
  >;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-shutdown-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    loadAgent = vi.fn(async (name: string) => makeAgent(name));
    executeAgent = vi.fn(async () => "ok");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("createRunController", () => {
    it("starts un-aborted", () => {
      const controller = createRunController();
      expect(controller.aborted).toBe(false);
      expect(controller.reason).toBeUndefined();
    });

    it("records the reason on abort", () => {
      const controller = createRunController();
      controller.abort("cancelled");
      expect(controller.aborted).toBe(true);
      expect(controller.reason).toBe("cancelled");
      expect(controller.signal.aborted).toBe(true);
    });

    it("keeps the first reason when aborted twice", () => {
      const controller = createRunController();
      controller.abort("cancelled");
      controller.abort("paused");
      expect(controller.reason).toBe("cancelled");
    });

    it("adopts an already-aborted parent signal", () => {
      const parent = new AbortController();
      parent.abort();
      expect(createRunController(parent.signal).aborted).toBe(true);
    });

    it("propagates a later parent abort", () => {
      const parent = new AbortController();
      const controller = createRunController(parent.signal);
      parent.abort();
      expect(controller.aborted).toBe(true);
    });

    it("tracks and drains work", async () => {
      const controller = createRunController();
      let finished = false;
      const work = controller.track(new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve(); }, 20)));
      const settled = await controller.settle(1000);
      expect(settled.drained).toBe(true);
      expect(finished).toBe(true);
      await work;
    });

    it("reports work that outlives the grace period", async () => {
      const controller = createRunController();
      controller.track(new Promise<void>(() => { /* never settles */ }));
      const settled = await controller.settle(20);
      expect(settled.drained).toBe(false);
      expect(settled.abandoned).toBe(1);
    });
  });

  describe("run shutdown", () => {
    it("pauses the run and records no node left running", async () => {
      const controller = new AbortController();

      registry.register({
        schema: { name: "hang", description: "hang", inputSchema: { type: "object" } },
        execute: async (_input, context) => {
          await new Promise<void>((resolve) => {
            const signal = context?.signal;
            if (!signal || signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
            controller.abort();
          });
          return { output: "stopped", isError: false };
        },
      });

      const run = await runWorkflow(
        workflow([
          { id: "hang", type: "tool", tool: "hang" },
          { id: "next", type: "tool", tool: "hang", dependsOn: ["hang"] },
        ]),
        {},
        { ...depsFor(store, registry, loadAgent, executeAgent), signal: controller.signal },
      );

      expect(run.status).toBe("paused");
      const node = await store.loadNode(run.id, "hang");
      expect(node?.status).not.toBe("running");
    });

    it("does not start a later node after a stop", async () => {
      const controller = new AbortController();
      let secondStarted = false;

      registry.register({
        schema: { name: "work", description: "work", inputSchema: { type: "object" } },
        execute: async (_input, context) => {
          if (secondStarted) return { output: "second", isError: false };
          secondStarted = true;
          await new Promise<void>((resolve) => {
            const signal = context?.signal;
            if (!signal || signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
            controller.abort();
          });
          return { output: "first", isError: false };
        },
      });

      const run = await runWorkflow(
        workflow([
          { id: "first", type: "tool", tool: "work" },
          { id: "second", type: "tool", tool: "work", dependsOn: ["first"] },
        ]),
        {},
        { ...depsFor(store, registry, loadAgent, executeAgent), signal: controller.signal },
      );

      expect(run.status).toBe("paused");
      expect(await store.loadNode(run.id, "second")).toBeFalsy();
    });

    it("warns when a tool ignores its signal and has to be abandoned", async () => {
      const controller = new AbortController();
      const onShutdownWarning = vi.fn();
      let started = false;

      registry.register({
        schema: { name: "stubborn", description: "stubborn", inputSchema: { type: "object" } },
        execute: async () => {
          started = true;
          controller.abort();
          // Stay in flight past the grace period.
          // Deliberately ignores the signal and keeps working.
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { output: "late", isError: false };
        },
      });

      const run = await runWorkflow(
        workflow([{ id: "stubborn", type: "tool", tool: "stubborn" }]),
        {},
        { ...depsFor(store, registry, loadAgent, executeAgent), signal: controller.signal, onShutdownWarning },
        { shutdownGraceMs: 20 },
      );

      expect(started).toBe(true);
      expect(run.status).toBe("paused");
      expect(onShutdownWarning).toHaveBeenCalled();
      expect(String(onShutdownWarning.mock.calls[0][0])).toContain("may still be running");
    });

    it("resumes a stopped run to completion with a fresh signal", async () => {
      const controller = new AbortController();
      let calls = 0;

      registry.register({
        schema: { name: "work", description: "work", inputSchema: { type: "object" } },
        execute: async (_input, context) => {
          calls++;
          if (calls === 1) {
            await new Promise<void>((resolve) => {
              // Attach the listener before aborting: the other order can miss
              // the abort that is meant to release this promise.
              const signal = context?.signal;
              if (!signal) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
              // Stop the run through the caller signal once the node is live.
              controller.abort();
            });
          }
          return { output: `done${calls}`, isError: false };
        },
      });

      const run = await runWorkflow(
        workflow([
          { id: "first", type: "tool", tool: "work" },
          { id: "second", type: "tool", tool: "work", dependsOn: ["first"] },
        ]),
        {},
        { ...depsFor(store, registry, loadAgent, executeAgent), signal: controller.signal },
      );

      expect(run.status).toBe("paused");

      // A restarted process would carry a fresh signal, not the dead one.
      const resumed = await resumeWorkflow(run.id, depsFor(store, registry, loadAgent, executeAgent));

      expect(resumed.status).toBe("passed");
      expect((await store.loadNode(run.id, "first"))?.status).toBe("passed");
      expect((await store.loadNode(run.id, "second"))?.status).toBe("passed");
    });

    it("refuses to resume while the caller's signal is still aborted", async () => {
      const controller = new AbortController();
      registry.register({
        schema: { name: "work", description: "work", inputSchema: { type: "object" } },
        execute: async () => ({ output: "done", isError: false }),
      });

      controller.abort();
      const run = await runWorkflow(
        workflow([{ id: "first", type: "tool", tool: "work" }]),
        {},
        { ...depsFor(store, registry, loadAgent, executeAgent), signal: controller.signal },
      );

      expect(run.status).toBe("paused");

      const resumed = await resumeWorkflow(run.id, {
        ...depsFor(store, registry, loadAgent, executeAgent),
        signal: controller.signal,
      });

      expect(resumed.status).toBe("paused");
    });

    it("gives a resumed run a fresh budget", async () => {
      registry.register({
        schema: { name: "work", description: "work", inputSchema: { type: "object" } },
        execute: async () => ({ output: "done", isError: false }),
      });

      const run = await runWorkflow(
        workflow([{ id: "only", type: "tool", tool: "work" }]),
        {},
        depsFor(store, registry, loadAgent, executeAgent),
      );

      expect(run.status).toBe("passed");
      const resumed = await resumeWorkflow(run.id, depsFor(store, registry, loadAgent, executeAgent));
      expect(resumed.status).toBe("passed");
    });
  });
});
