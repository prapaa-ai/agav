import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsent } from "../workflows/grant.js";
import { launchRun, LaunchEnvironmentError } from "../workflows/launch.js";
import { createRun } from "../workflows/runtime.js";
import { runnerRequestId, WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, FakeCoordinator, registry, tempStore } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { vi.restoreAllMocks(); await cleanup(); });

const CLI = "/opt/agav/build/cli.js";
const definition = def([{ id: "a", type: "job", command: "echo hi" }]);
const read = (id: string) => store.read(id, registry);

async function pending(): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "auto-accept", ["RACE_TOKEN"]);
  await store.lock(run.id, () => store.save(run));
  return run;
}

/** Deterministic interleaving: a concurrent writer wins the run lock before launchRun's first locked update. */
async function race(id: string, change: (run: WorkflowRun) => void, sandboxRequired = true) {
  const realLock = store.lock.bind(store);
  let first = true;
  vi.spyOn(store, "lock").mockImplementation(async (lockId, fn) => {
    if (first && lockId === id) {
      first = false;
      await realLock(id, async () => { const current = await read(id); change(current); await store.save(current); });
    }
    return realLock(lockId, fn);
  });
  return launchRun(store, id, { coordinator: new FakeCoordinator(), cliPath: CLI, admissionEnv: {}, sandboxRequired });
}

describe("launchRun missing-env path vs a concurrent writer (pending snapshot)", () => {
  it("a concurrent caller that queued the run first does not stop the strict caller's requirement being persisted", async () => {
    const r = await pending();
    const result = await race(r.id, current => { current.status = "queued"; current.runner = { attempt: 1, requestId: runnerRequestId(r.id, 1), relaunches: 0 }; });
    expect(result.status).toBe("queued");
    const after = await read(r.id);
    expect(after.sandboxRequired).toBe(true);
    expect(after.status).toBe("queued");
    expect(after.runner?.requestId).toBe(runnerRequestId(r.id, 1));
  });

  it("a waiting_approval run is not moved, and still gets the requirement", async () => {
    const r = await pending();
    const result = await race(r.id, current => { current.status = "waiting_approval"; });
    expect(result.status).toBe("queued");
    const after = await read(r.id);
    expect(after.status).toBe("waiting_approval");
    expect(after.sandboxRequired).toBe(true);
  });

  it("an interrupted run is refused (not queued) but the requirement is persisted", async () => {
    const r = await pending();
    await expect(race(r.id, current => { current.status = "interrupted"; })).rejects.toBeInstanceOf(LaunchEnvironmentError);
    const after = await read(r.id);
    expect(after.status).toBe("interrupted");
    expect(after.sandboxRequired).toBe(true);
  });

  it("a run that went terminal meanwhile is attached and left untouched", async () => {
    const r = await pending();
    const result = await race(r.id, current => { current.status = "cancelled"; });
    expect(result.status).toBe("attached");
    const after = await read(r.id);
    expect(after.status).toBe("cancelled");
    expect(after.sandboxRequired).toBeUndefined();
  });

  it("a running run is neither requeued nor reported as deferred, and gets the requirement", async () => {
    const r = await pending();
    const result = await race(r.id, current => { current.status = "running"; });
    expect(result.status).toBe("attached");
    const after = await read(r.id);
    expect(after.status).toBe("running");
    expect(after.sandboxRequired).toBe(true);
  });

  it("never weakens: a strict run stays strict when the concurrent caller is not strict", async () => {
    const r = await pending();
    const result = await race(r.id, current => { current.status = "queued"; current.sandboxRequired = true; current.runner = { attempt: 1, requestId: runnerRequestId(r.id, 1), relaunches: 0 }; }, false);
    expect(result.status).toBe("queued");
    expect((await read(r.id)).sandboxRequired).toBe(true);
  });

  it("a non-strict caller adds no requirement when beaten to the transition", async () => {
    const r = await pending();
    await race(r.id, current => { current.status = "queued"; current.runner = { attempt: 1, requestId: runnerRequestId(r.id, 1), relaunches: 0 }; }, false);
    expect((await read(r.id)).sandboxRequired).toBeUndefined();
  });

  it("the normal uncontended pending -> queued transition still persists the requirement", async () => {
    const r = await pending();
    const result = await launchRun(store, r.id, { coordinator: new FakeCoordinator(), cliPath: CLI, admissionEnv: {}, sandboxRequired: true });
    expect(result.status).toBe("queued");
    const after = await read(r.id);
    expect([after.status, after.sandboxRequired]).toEqual(["queued", true]);
  });

  it("fails closed when persisting the requirement fails after losing the race", async () => {
    const r = await pending();
    const realLock = store.lock.bind(store);
    let first = true;
    vi.spyOn(store, "lock").mockImplementation(async (lockId, fn) => {
      if (first) { first = false; await realLock(r.id, async () => { const c = await read(r.id); c.status = "queued"; c.runner = { attempt: 1, requestId: runnerRequestId(r.id, 1), relaunches: 0 }; await store.save(c); }); vi.spyOn(store, "save").mockRejectedValue(new Error("ENOSPC")); }
      return realLock(lockId, fn);
    });
    await expect(launchRun(store, r.id, { coordinator: new FakeCoordinator(), cliPath: CLI, admissionEnv: {}, sandboxRequired: true })).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();
    expect((await read(r.id)).sandboxRequired).toBeUndefined();
  });

  it("a later capable launch retains the strict requirement and starts the runner", async () => {
    const r = await pending();
    await race(r.id, current => { current.status = "queued"; current.runner = { attempt: 1, requestId: runnerRequestId(r.id, 1), relaunches: 0 }; });
    vi.restoreAllMocks();
    const coordinator = new FakeCoordinator();
    const result = await launchRun(store, r.id, { coordinator, cliPath: CLI, admissionEnv: { RACE_TOKEN: "x" }, sandboxRequired: false });
    expect(result.status).toBe("started");
    expect(coordinator.starts).toHaveLength(1);
    expect((await read(r.id)).sandboxRequired).toBe(true);
  });
});
