import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { cancelRun } from "../workflows/control.js";
import { readEvents } from "../workflows/events.js";
import { buildConsent } from "../workflows/grant.js";
import { launchRun } from "../workflows/launch.js";
import { runnerJobDeps, startRunner } from "../workflows/runner.js";
import { createRun } from "../workflows/runtime.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import { def, FakeCoordinator, jobDeps, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const jobDef = def([{ id: "a", type: "job", command: "sleep 100" }]);

async function consented(definition: WorkflowDefinition, permissionMode: "ask" | "auto-accept" = "ask"): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, permissionMode, []);
  await store.lock(run.id, () => store.save(run));
  return run;
}
async function until(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

describe("startRunner", () => {
  it("executes with the consent's job commands under a headless session", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented(def([{ id: "a", type: "job", command: "echo hi" }]));
    const handle = startRunner(run.id, { store, registry, config: testConfig(), getCoordinator: async () => coordinator, jobDepsOverrides: { pollIntervalMs: 5 } });
    expect((await handle.done).status).toBe("passed");
    expect(coordinator.starts[0]).toMatchObject({ headless: true, invocation: { mode: "shell", commandText: "echo hi" } });
  });

  it("refuses a run without consent", async () => {
    const run = await createRun(store, jobDef, {}, { host: "background" });
    const handle = startRunner(run.id, { store, registry, config: testConfig(), getCoordinator: async () => new FakeCoordinator() });
    await expect(handle.done).rejects.toThrow(/no background consent/);
  });

  it("SIGTERM shutdown aborts, stops the child job and checkpoints cancelled within the grace", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = ["running"];
    const run = await consented(jobDef);
    const handle = startRunner(run.id, { store, registry, config: testConfig(), getCoordinator: async () => coordinator, jobDepsOverrides: { pollIntervalMs: 5, stopSettleMs: 200 } });
    await until(async () => coordinator.starts.length === 1 && (await store.read(run.id, registry)).nodes[0]!.job?.jobId !== undefined);
    const started = Date.now();
    const settled = await handle.shutdown();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(settled?.status).toBe("cancelled");
    expect(coordinator.stops).toEqual(["job-1"]);
    const saved = await store.read(run.id, registry);
    expect(saved.status).toBe("cancelled");
    expect(saved.nodes[0]).toMatchObject({ status: "cancelled", job: { jobId: "job-1", state: "interrupted" } });
    expect(await store.cancellationRequested(run.id)).toBe(true);
    expect((await readEvents(store, run.id)).at(-1)).toMatchObject({ type: "run_status", status: "cancelled" });
  });

  it("parks tools outside the consent in ask mode on a tool_consent decision (background host)", async () => {
    const definition = def([{ id: "w", type: "tool", tool: "write_file", input: { path: "x.txt", content: "y" } }]);
    const run = await consented(definition);
    // Tamper: drop the tool from the consent; the background host must then ask instead of running it.
    run.consent!.capabilities.tools = [];
    await store.lock(run.id, () => store.save(run));
    const handle = startRunner(run.id, { store, registry, config: testConfig({ permissionMode: "auto-accept" }), getCoordinator: async () => new FakeCoordinator() });
    const done = await handle.done;
    expect(done.status).toBe("waiting_approval");
    expect(done.nodes[0]).toMatchObject({ status: "waiting_approval", decisionId: expect.stringMatching(/^dec_/) });
    expect(done.nodes[0]!.output).toBeUndefined();
  });
});

describe("runnerJobDeps", () => {
  it("refuses to start job commands the consent does not cover", async () => {
    const coordinator = new FakeCoordinator();
    const consent = buildConsent(jobDef, "/work", "ask", []);
    const deps = runnerJobDeps(consent, async () => coordinator, false);
    const guarded = await deps.getCoordinator();
    const session = typeof deps.session === "function" ? deps.session() : deps.session;
    expect(session.headlessApprovedActions).toEqual(["start", "stop"]);
    expect(deps.headless).toBe(true);
    await expect(guarded.start({ requestId: "r", invocation: { mode: "shell", interpreter: "posix-sh", commandText: "rm -rf /" }, cwd: "/work", isolation: { backend: "none", required: false } }, session)).rejects.toThrow(/not covered/);
    await guarded.start({ requestId: "r2", invocation: { mode: "shell", interpreter: "posix-sh", commandText: "sleep 100" }, cwd: "/work", isolation: { backend: "none", required: false } }, session);
    expect(coordinator.starts.map(request => request.requestId)).toEqual(["r2"]);
  });
});

describe("cancelRun with a runner", () => {
  it("writes the cancel marker and stops the live runner job", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented(def([{ id: "g", type: "approval", prompt: "ok?" }]));
    await launchRun(store, run.id, { coordinator, cliPath: "/cli.js" });
    const cancelled = await cancelRun(store, run.id, registry, undefined, jobDeps(coordinator));
    expect(coordinator.stops).toEqual(["job-1"]);
    expect(await store.cancellationRequested(run.id)).toBe(true);
    expect(cancelled.status).toBe("cancelled");
  });
});
