import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decideApproval, decisionSummary } from "../workflows/control.js";
import { launchSummary } from "../workflows/background.js";
import { readEvents } from "../workflows/events.js";
import { listPendingDecisions } from "../workflows/decisions.js";
import { buildConsent } from "../workflows/grant.js";
import { launchRun, LaunchEnvironmentError } from "../workflows/launch.js";
import { reconcileRun } from "../workflows/reconcile.js";
import { startRunner } from "../workflows/runner.js";
import { createRun } from "../workflows/runtime.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const CLI = "/opt/agav/build/cli.js";
const SECRET = "s3cr3t-token-value-L";
const gated = def([{ id: "gate", type: "approval", prompt: "go?" }, { id: "j", type: "job", command: "echo hi", dependsOn: ["gate"] }]);

async function consented(definition: WorkflowDefinition = gated, envNames: string[] = ["L_TOKEN"]): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "auto-accept", envNames);
  await store.lock(run.id, () => store.save(run));
  return run;
}
const last = async (id: string) => (await readEvents(store, id)).filter(event => event.type === "run_status").at(-1);
const read = (id: string) => store.read(id, registry);

/** Launched (with the env) then parked on its approval by a runner that has since exited: a finished attempt-1 job. */
async function parked(coordinator: FakeCoordinator): Promise<WorkflowRun> {
  const run = await consented();
  await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } });
  expect((await startRunner(run.id, { store, registry, config: testConfig(), getCoordinator: async () => new FakeCoordinator(), jobDepsOverrides: { pollIntervalMs: 5 } }).done).status).toBe("waiting_approval");
  const job = [...coordinator.jobs.values()][0]!;
  coordinator.jobs.set(job.jobId, { ...job, state: "completed" });
  return read(run.id);
}

describe("launch boundary enforces the selected environment (P2)", () => {
  it("initial launch from a context lacking the env queues with a reason and starts nothing", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented();
    const result = await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {} });
    expect(result).toMatchObject({ status: "queued", reason: expect.stringContaining("L_TOKEN") });
    expect(coordinator.starts).toHaveLength(0);
    const saved = await read(run.id);
    expect(saved.status).toBe("queued");
    expect(saved.runner).toEqual({ attempt: 1, requestId: `wf-run-${run.id}-1`, relaunches: 0 });
    expect(await last(run.id)).toMatchObject({ status: "queued", reason: expect.stringContaining("L_TOKEN") });
    expect(launchSummary(result)).toContain("L_TOKEN");
    // A capable context admits it, passing the NAME only.
    expect((await reconcileRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } })).action).toBe("admitted");
    expect(coordinator.starts).toHaveLength(1);
    expect(coordinator.starts[0]).toMatchObject({ requestId: `wf-run-${run.id}-1`, envInherit: ["L_TOKEN"] });
    expect(JSON.stringify(coordinator.starts)).not.toContain(SECRET);
  });

  it("a deferral is recorded once per reason and defaults to process.env", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented(gated, ["AGAV_TEST_LAUNCH_TOKEN"]);
    delete process.env.AGAV_TEST_LAUNCH_TOKEN;
    for (let i = 0; i < 3; i++) expect((await launchRun(store, run.id, { coordinator, cliPath: CLI })).status).toBe("queued");
    expect((await readEvents(store, run.id)).filter(event => event.type === "run_status" && event.reason?.includes("AGAV_TEST_LAUNCH_TOKEN"))).toHaveLength(1);
    process.env.AGAV_TEST_LAUNCH_TOKEN = SECRET;
    try { expect((await launchRun(store, run.id, { coordinator, cliPath: CLI })).status).toBe("started"); }
    finally { delete process.env.AGAV_TEST_LAUNCH_TOKEN; }
  });

  it("resume of a parked run without the env leaves it parked on the same attempt; a capable context relaunches it", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parked(coordinator);
    const before = run.runner;
    const result = await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {} });
    expect(result).toMatchObject({ status: "queued", reason: expect.stringContaining("L_TOKEN") });
    expect(coordinator.starts).toHaveLength(1);
    const after = await read(run.id);
    expect(after.status).toBe("waiting_approval");
    expect(after.runner).toEqual(before);
    expect(await last(run.id)).toMatchObject({ status: "waiting_approval", reason: expect.stringContaining("L_TOKEN") });

    expect((await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } })).status).toBe("started");
    expect(coordinator.starts).toHaveLength(2);
    expect((await read(run.id)).runner).toMatchObject({ attempt: 2, requestId: `wf-run-${run.id}-2` });
  });

  it("resume of an interrupted run without the env is refused explicitly and changes nothing when no sandbox is requested", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented();
    await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } });
    const job = [...coordinator.jobs.values()][0]!;
    coordinator.jobs.set(job.jobId, { ...job, state: "failed" });
    const interrupted = await read(run.id);
    interrupted.status = "interrupted";
    await store.lock(run.id, () => store.save(interrupted));
    const events = (await readEvents(store, run.id)).length;
    await expect(launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {} })).rejects.toBeInstanceOf(LaunchEnvironmentError);
    await expect(launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {} })).rejects.toThrow(/L_TOKEN/);
    const after = await read(run.id);
    expect(after.status).toBe("interrupted");
    expect(after.runner).toMatchObject({ attempt: 1 });
    expect((await readEvents(store, run.id)).length).toBe(events);
    expect(coordinator.starts).toHaveLength(1);
    expect((await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } })).status).toBe("started");
  });

  /** Parked on its approval (pending decision, finished attempt-1 runner), then marked interrupted. */
  async function interruptedRun(coordinator: FakeCoordinator): Promise<WorkflowRun> {
    const run = await parked(coordinator);
    run.status = "interrupted";
    await store.lock(run.id, () => store.save(run));
    return read(run.id);
  }

  it("an interrupted approval deferred for a missing env persists sandboxRequired; a later non-sandboxed capable context still enforces it", async () => {
    const coordinator = new FakeCoordinator();
    const run = await interruptedRun(coordinator);
    expect(run.sandboxRequired).not.toBe(true);
    await expect(launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {}, sandboxRequired: true })).rejects.toBeInstanceOf(LaunchEnvironmentError);
    const after = await read(run.id);
    expect(after.status).toBe("interrupted");
    expect(after.sandboxRequired).toBe(true);
    expect(coordinator.starts).toHaveLength(1);
    expect((await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET }, sandboxRequired: false })).status).toBe("started");
    expect((await read(run.id)).sandboxRequired).toBe(true);
  });

  it("the control path reports the deferral only after the stricter requirement is persisted", async () => {
    const coordinator = new FakeCoordinator();
    const run = await interruptedRun(coordinator);
    const result = await decideApproval(store, run.id, "gate", true, { registry, by: "u@h", launch: { coordinator, cliPath: CLI, admissionEnv: {}, sandboxRequired: true } });
    expect(result.won).toBe(true);
    expect(result.relaunch).toMatchObject({ status: "manual-resume-required", manualResumeRequired: true, reason: expect.stringContaining("L_TOKEN") });
    expect(result.run.status).toBe("interrupted");
    const summary = decisionSummary(result);
    expect(summary).toContain("L_TOKEN");
    expect(summary).toContain("manual resume required");
    expect(summary).toContain(`agav workflows resume ${run.id}`);
    expect(summary).not.toMatch(/runner queued/);
    expect(summary).toContain("not launched or queued");
    const after = await read(run.id);
    expect(after.status).toBe("interrupted");
    expect(after.sandboxRequired).toBe(true);
    expect(coordinator.starts).toHaveLength(1);
    // The decision stays recorded, and automatic reconcile never revisits (launches) an interrupted run, even from a capable context.
    expect(await listPendingDecisions(store, run.id)).toEqual([]);
    expect(await reconcileRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } })).toMatchObject({ action: "none" });
    expect(coordinator.starts).toHaveLength(1);
    expect((await read(run.id)).status).toBe("interrupted");
    // Only the manual resume from a capable context launches it (new attempt), still enforcing the persisted requirement.
    expect((await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET }, sandboxRequired: false })).status).toBe("started");
    expect(coordinator.starts).toHaveLength(2);
    expect((await read(run.id)).sandboxRequired).toBe(true);
  });

  it("a deferred relaunch of a parked (non-interrupted) run is still reported as queued", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parked(coordinator);
    const result = await decideApproval(store, run.id, "gate", true, { registry, by: "u@h", launch: { coordinator, cliPath: CLI, admissionEnv: {} } });
    expect(result.relaunch).toMatchObject({ status: "queued" });
    expect((result.relaunch as { manualResumeRequired?: boolean }).manualResumeRequired).toBeUndefined();
    expect(decisionSummary(result)).toContain("runner queued");
  });

  it("fails closed when the stricter requirement cannot be persisted: the write error propagates, no safe deferral", async () => {
    const coordinator = new FakeCoordinator();
    const run = await interruptedRun(coordinator);
    const save = vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));
    try {
      await expect(launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {}, sandboxRequired: true })).rejects.toThrow("disk full");
      await expect(decideApproval(store, run.id, "gate", true, { registry, by: "u@h", launch: { coordinator, cliPath: CLI, admissionEnv: {}, sandboxRequired: true } })).rejects.toThrow("disk full");
    } finally { save.mockRestore(); }
    expect((await read(run.id)).sandboxRequired).not.toBe(true);
    expect(coordinator.starts).toHaveLength(1);
  });

  it("attaching to an already-live runner needs no env", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented();
    await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } });
    const result = await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {} });
    expect(result).toMatchObject({ status: "attached", job: { jobId: "job-1" } });
    expect(result.reason).toBeUndefined();
    expect(coordinator.starts).toHaveLength(1);
  });

  it("approval is recorded even when the relaunch is deferred; a capable context then applies it", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parked(coordinator);
    const result = await decideApproval(store, run.id, "gate", true, { registry, by: "u@h", launch: { coordinator, cliPath: CLI, admissionEnv: {} } });
    expect(result.won).toBe(true);
    expect(result.relaunch).toMatchObject({ status: "queued", reason: expect.stringContaining("L_TOKEN") });
    expect(decisionSummary(result)).toContain("L_TOKEN");
    expect(coordinator.starts).toHaveLength(1);
    const state = await read(run.id);
    expect(state.status).toBe("waiting_approval");
    expect(state.runner).toMatchObject({ attempt: 1 });
    expect(await listPendingDecisions(store, run.id)).toEqual([]);

    // Not stranded: reconcile (parked + decided) is also deferred without the env, and relaunches with it.
    expect(await reconcileRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {} })).toMatchObject({ action: "none", reason: expect.stringContaining("L_TOKEN") });
    expect(coordinator.starts).toHaveLength(1);
    expect((await reconcileRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } })).action).toBe("relaunched");
    expect(coordinator.starts).toHaveLength(2);
    expect(coordinator.starts[1]).toMatchObject({ requestId: `wf-run-${run.id}-2`, envInherit: ["L_TOKEN"] });
  });

  it("approval while the runner is still live needs no env", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parked(coordinator);
    const job = [...coordinator.jobs.values()][0]!;
    coordinator.jobs.set(job.jobId, { ...job, state: "running" });
    const result = await decideApproval(store, run.id, "gate", true, { registry, by: "u@h", parkWaitMs: 0, launch: { coordinator, cliPath: CLI, admissionEnv: {} } });
    expect(result.relaunch).toBe("live");
    expect(coordinator.starts).toHaveLength(1);
  });

  it("never persists env values", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parked(coordinator);
    await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { OTHER: SECRET } });
    await decideApproval(store, run.id, "gate", true, { registry, launch: { coordinator, cliPath: CLI, admissionEnv: { OTHER: SECRET } } });
    await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { L_TOKEN: SECRET } });
    const files: string[] = [];
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) entry.isDirectory() ? walk(join(dir, entry.name)) : files.push(readFileSync(join(dir, entry.name), "utf8")); };
    if (existsSync(store.root)) walk(store.root);
    expect(files.join("\n")).not.toContain(SECRET);
    expect(JSON.stringify(coordinator.starts)).not.toContain(SECRET);
  });
});
