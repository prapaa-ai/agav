import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { JobSummary } from "../background-jobs/types.js";
import { buildConsent } from "../workflows/grant.js";
import { createPendingDecision, decide, listPendingDecisions } from "../workflows/decisions.js";
import { launchRun } from "../workflows/launch.js";
import { MAX_RUNNER_RELAUNCHES, reconcileRun, reconcileRuns } from "../workflows/reconcile.js";
import { createRun } from "../workflows/runtime.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import { def, FakeCoordinator, registry, tempStore } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const CLI = "/opt/agav/build/cli.js";
const jobDef = def([{ id: "a", type: "job", command: "echo hi" }]);
const toolDef = def([{ id: "w", type: "tool", tool: "write_file", input: { path: "x", content: "y" } }]);

/** A launched run whose runner has taken the lock and saved `running`. */
async function launched(coordinator: FakeCoordinator, definition: WorkflowDefinition = jobDef, mutate?: (run: WorkflowRun) => void): Promise<WorkflowRun> {
  const created = await createRun(store, definition, {}, { host: "background" });
  created.consent = buildConsent(definition, created.cwd, "ask", []);
  await store.lock(created.id, () => store.save(created));
  await launchRun(store, created.id, { coordinator, cliPath: CLI });
  const run = await store.read(created.id, registry);
  run.status = "running";
  mutate?.(run);
  await store.lock(run.id, () => store.save(run));
  return run;
}
function setRunnerState(coordinator: FakeCoordinator, requestId: string, state: JobSummary["state"]): void {
  const job = [...coordinator.jobs.values()].find(item => item.requestId === requestId)!;
  coordinator.jobs.set(job.jobId, { ...job, state });
}
const deps = (coordinator: FakeCoordinator) => ({ coordinator, cliPath: CLI });

describe("reconcileRun decision table", () => {
  it("does nothing while the runner job is live", async () => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator);
    expect(await reconcileRun(store, run.id, deps(coordinator))).toEqual({ runId: run.id, action: "none" });
    expect((await store.read(run.id, registry)).status).toBe("running");
    expect(coordinator.starts).toHaveLength(1);
  });

  it.each(["completed", "failed", "interrupted"] as const)("relaunches attempt+1 when the runner is %s", async state => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator);
    setRunnerState(coordinator, run.runner!.requestId, state);
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("relaunched");
    const after = await store.read(run.id, registry);
    expect(after.runner).toMatchObject({ attempt: 2, requestId: `wf-run-${run.id}-2`, relaunches: 1 });
    expect(after.status).toBe("queued");
    expect(coordinator.starts.map(request => request.requestId)).toEqual([`wf-run-${run.id}-1`, `wf-run-${run.id}-2`]);
  });

  it("relaunches when the runner job is missing", async () => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator);
    coordinator.jobs.clear();
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("relaunched");
    expect(coordinator.starts.at(-1)!.requestId).toBe(`wf-run-${run.id}-2`);
  });

  it.each(["unknown", "recovery-required"] as const)("marks a %s runner interrupted and never relaunches it", async state => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator);
    setRunnerState(coordinator, run.runner!.requestId, state);
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("interrupted-unknown");
    const after = await store.read(run.id, registry);
    expect(after.status).toBe("interrupted");
    expect(after.runner).toMatchObject({ attempt: 1, relaunches: 0 });
    expect(coordinator.starts).toHaveLength(1);
    // A later reconcile leaves it alone.
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("none");
    expect(coordinator.starts).toHaveLength(1);
  });

  it("parks an interrupted mutating tool node on an uncertain_tool decision and does not relaunch", async () => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator, toolDef, r => { r.nodes[0]!.status = "running"; r.nodes[0]!.startedAt = new Date().toISOString(); });
    setRunnerState(coordinator, run.runner!.requestId, "failed");
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("parked");
    const after = await store.read(run.id, registry);
    expect(after.status).toBe("waiting_approval");
    expect(after.nodes[0]).toMatchObject({ status: "waiting_approval", decisionId: expect.stringMatching(/^dec_/) });
    expect((await listPendingDecisions(store, run.id)).map(item => item.kind)).toEqual(["uncertain_tool"]);
    expect(coordinator.starts).toHaveLength(1);
  });

  it("relaunches a parked run whose decision was decided after its runner exited", async () => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator, def([{ id: "g", type: "approval", prompt: "ok?" }]), r => { r.status = "waiting_approval"; r.nodes[0]!.status = "waiting_approval"; });
    setRunnerState(coordinator, run.runner!.requestId, "completed");
    const pending = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "g", summary: "ok?" });
    const parked = await store.read(run.id, registry);
    parked.nodes[0]!.decisionId = pending.decisionId;
    await store.lock(run.id, () => store.save(parked));
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("none");
    await decide(store, run.id, pending.decisionId, true, "u@h");
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("relaunched");
    expect(coordinator.starts.map(request => request.requestId)).toEqual([`wf-run-${run.id}-1`, `wf-run-${run.id}-2`]);
  });

  it("ignores terminal and parked runs", async () => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator, def([{ id: "g", type: "approval", prompt: "ok?" }]), r => { r.status = "waiting_approval"; r.nodes[0]!.status = "waiting_approval"; });
    setRunnerState(coordinator, run.runner!.requestId, "completed");
    expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("none");
    expect(coordinator.starts).toHaveLength(1);
  });
});

describe("relaunch bound", () => {
  it(`relaunches at most ${MAX_RUNNER_RELAUNCHES} times, then leaves the run interrupted`, async () => {
    const coordinator = new FakeCoordinator();
    const run = await launched(coordinator);
    for (let i = 1; i <= MAX_RUNNER_RELAUNCHES; i++) {
      const current = await store.read(run.id, registry);
      setRunnerState(coordinator, current.runner!.requestId, "failed");
      if (current.status !== "running") { current.status = "running"; await store.lock(run.id, () => store.save(current)); }
      expect((await reconcileRun(store, run.id, deps(coordinator))).action).toBe("relaunched");
    }
    const last = await store.read(run.id, registry);
    last.status = "running"; await store.lock(run.id, () => store.save(last));
    setRunnerState(coordinator, last.runner!.requestId, "failed");
    expect(await reconcileRun(store, run.id, deps(coordinator))).toMatchObject({ action: "interrupted" });
    const after = await store.read(run.id, registry);
    expect(after.status).toBe("interrupted");
    expect(after.runner).toMatchObject({ attempt: MAX_RUNNER_RELAUNCHES + 1, relaunches: MAX_RUNNER_RELAUNCHES });
    expect(coordinator.starts).toHaveLength(MAX_RUNNER_RELAUNCHES + 1);
  });
});

describe("reconcileRuns", () => {
  it("reconciles dead runners before admitting queued runs into the freed slot", async () => {
    const coordinator = new FakeCoordinator();
    const dead = await launched(coordinator);
    const waiting = await createRun(store, jobDef, {}, { host: "background" });
    waiting.consent = buildConsent(jobDef, waiting.cwd, "ask", []);
    await store.lock(waiting.id, () => store.save(waiting));
    expect((await launchRun(store, waiting.id, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 })).status).toBe("queued");
    setRunnerState(coordinator, dead.runner!.requestId, "unknown");

    const results = await reconcileRuns(store, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 });
    expect(results).toContainEqual({ runId: dead.id, action: "interrupted-unknown", reason: "runner unknown" });
    expect(results).toContainEqual({ runId: waiting.id, action: "admitted" });
    expect(coordinator.starts.map(request => request.requestId)).toEqual([`wf-run-${dead.id}-1`, `wf-run-${waiting.id}-1`]);
  });
});
