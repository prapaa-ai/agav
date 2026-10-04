import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentDefinition } from "../agents/types.js";
import { runWorkflow } from "../workflows/runtime.js";
import { WorkflowStore } from "../workflows/store.js";
import {
  clearNotifications,
  readNotifications,
  refreshWorkflowRunNotifications,
  stopWorkflowRunNotificationPolling,
  subscribeToWorkflowRunEvents,
  type WorkflowRunEvent,
} from "../workflows/notifications.js";
import type { WorkflowDefinition } from "../workflows/types.js";

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

function workflow(): WorkflowDefinition {
  return {
    version: 1,
    name: "notify-flow",
    policies: { sandbox: "none" },
    nodes: [{ id: "only", type: "agent", agent: "a", task: "go" }],
  };
}

describe("workflow completion notifications", () => {
  let dir: string;
  let store: WorkflowStore;
  let registry: ToolRegistry;
  let previousAgavDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-workflow-notify-"));
    store = new WorkflowStore({ rootDir: dir });
    registry = new ToolRegistry();
    previousAgavDir = process.env["AGAV_CONFIG_DIR"];
    // Keep the always-on log inside the temp dir.
    process.env["AGAV_CONFIG_DIR"] = join(dir, "agav");
    await clearNotifications();
  });

  afterEach(async () => {
    stopWorkflowRunNotificationPolling();
    if (previousAgavDir === undefined) delete process.env["AGAV_CONFIG_DIR"];
    else process.env["AGAV_CONFIG_DIR"] = previousAgavDir;
    await rm(dir, { recursive: true, force: true });
  });

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      provider: new MockProvider(),
      config,
      toolRegistry: registry,
      loadAgent: async (name: string) => makeAgent(name),
      executeAgent: async () => "ok",
      store,
      ...overrides,
    };
  }

  it("calls onComplete exactly once when a run finishes", async () => {
    const onComplete = vi.fn();

    await runWorkflow(workflow(), {}, deps({ onComplete }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].status).toBe("passed");
  });

  it("reports a failed run through onComplete too", async () => {
    const onComplete = vi.fn();
    registry.register({
      schema: { name: "boom", description: "boom", inputSchema: { type: "object" }, destructive: false },
      execute: async () => ({ output: "nope", isError: true }),
    });

    await runWorkflow(
      { version: 1, name: "fail-flow", policies: { sandbox: "none" }, nodes: [{ id: "x", type: "tool", tool: "boom" }] },
      {},
      deps({ onComplete }),
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].status).toBe("failed");
  });

  it("does not call onComplete when a run is waiting for approval", async () => {
    const onComplete = vi.fn();

    await runWorkflow(
      {
        version: 1,
        name: "gate-flow",
        policies: { sandbox: "none" },
        nodes: [{ id: "gate", type: "approval", prompt: "ok?" }],
      },
      {},
      deps({ onComplete }),
    );

    // A paused run is not finished; it should surface through the approval path.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("survives a notifier that throws", async () => {
    const onComplete = vi.fn(() => {
      throw new Error("notifier exploded");
    });

    const run = await runWorkflow(workflow(), {}, deps({ onComplete }));

    // A broken notifier must not turn a successful run into a failed one.
    expect(run.status).toBe("passed");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("delivers an unnotified finished run exactly once", async () => {
    const run = await runWorkflow(workflow(), {}, deps());

    const first = await refreshWorkflowRunNotifications(store);
    expect(first).toHaveLength(1);
    expect(first[0].runId).toBe(run.id);
    expect(first[0].status).toBe("passed");

    // Second poll must not repeat the message.
    const second = await refreshWorkflowRunNotifications(store);
    expect(second).toEqual([]);
  });

  it("stamps notifiedAt on the persisted run", async () => {
    const run = await runWorkflow(workflow(), {}, deps());
    expect((await store.loadRun(run.id))?.notifiedAt).toBeUndefined();

    await refreshWorkflowRunNotifications(store);

    expect((await store.loadRun(run.id))?.notifiedAt).toBeTruthy();
  });

  it("appends to the notification log so a headless run leaves a trail", async () => {
    const run = await runWorkflow(workflow(), {}, deps());

    await refreshWorkflowRunNotifications(store);

    const log = await readNotifications();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(run.id);
    expect(log[0]).toContain("passed");
  });

  it("forwards events to extra sinks", async () => {
    const seen: WorkflowRunEvent[] = [];

    await runWorkflow(workflow(), {}, deps());
    await refreshWorkflowRunNotifications(store, [(event) => { seen.push(event); }]);

    expect(seen).toHaveLength(1);
    expect(seen[0].workflowName).toBe("notify-flow");
  });

  it("keeps notifying other sinks when one throws", async () => {
    const good = vi.fn();

    await runWorkflow(workflow(), {}, deps());
    await refreshWorkflowRunNotifications(store, [() => { throw new Error("bad sink"); }, good]);

    expect(good).toHaveBeenCalledTimes(1);
  });

  it("notifies a subscriber and stops after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToWorkflowRunEvents(listener, { store });

    // Drive the delivery explicitly rather than waiting on the shared poll, so
    // the assertion does not depend on timer scheduling.
    await runWorkflow(workflow(), {}, deps());
    const delivered = await refreshWorkflowRunNotifications(store);
    expect(delivered).toHaveLength(1);
    // Still subscribed, so the live listener was told.
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    // A later run is still reported through an explicit refresh, which is how a
    // fresh session picks up what it missed.
    const second = await runWorkflow(workflow(), {}, deps());
    expect(await refreshWorkflowRunNotifications(store)).toHaveLength(1);
    expect((await store.loadRun(second.id))?.notifiedAt).toBeTruthy();
    // After unsubscribing, no further event is pushed to this listener.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers to an active subscriber", async () => {
    const listener = vi.fn();
    subscribeToWorkflowRunEvents(listener, { store });

    await runWorkflow(workflow(), {}, deps());
    await refreshWorkflowRunNotifications(store);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].workflowName).toBe("notify-flow");
  });
  it("ignores a run that is not finished", async () => {
    // A run parked at an approval gate is still in flight, so it must not be
    // reported as complete.
    const gated = await runWorkflow(
      {
        version: 1,
        name: "gate-flow",
        policies: { sandbox: "none" },
        nodes: [{ id: "gate", type: "approval", prompt: "ok?" }],
      },
      {},
      deps(),
    );

    const delivered = await refreshWorkflowRunNotifications(store);
    expect(delivered).toEqual([]);
    expect((await store.loadRun(gated.id))?.notifiedAt).toBeUndefined();
  });

  it("delivers exactly one notification per run across repeated refreshes", async () => {
    // The reported symptom was several notifications for one finished workflow.
    // Two independent causes are pinned here: the once-only stamp, and a single
    // desktop call rather than a primary attempt plus a fallback.
    const run = await runWorkflow(workflow(), {}, deps());

    const desktop = vi.fn(async () => true);
    const bell = vi.fn();

    // Several polls, as a background session and a manual command would both do.
    for (let i = 0; i < 4; i++) {
      await refreshWorkflowRunNotifications(store, [desktop, bell]);
    }

    expect(desktop).toHaveBeenCalledTimes(1);
    expect(bell).toHaveBeenCalledTimes(1);

    // And the durable log agrees: one line, for this run.
    const log = await readNotifications();
    expect(log.filter((line) => line.includes(run.id))).toHaveLength(1);
  });

  it("delivers one notification per run when several finish", async () => {
    const first = await runWorkflow(workflow(), {}, deps());
    const second = await runWorkflow(workflow(), {}, deps());

    const seen: string[] = [];
    const desktop = vi.fn(async (event: { runId: string }) => {
      seen.push(event.runId);
      return true;
    });
    await refreshWorkflowRunNotifications(store, [desktop]);

    // One each, not one for the batch and one for the first run.
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(seen.sort()).toEqual([first.id, second.id].sort());

    // A second pass adds nothing.
    await refreshWorkflowRunNotifications(store, [desktop]);
    expect(desktop).toHaveBeenCalledTimes(2);
  });});
