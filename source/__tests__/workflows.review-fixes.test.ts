import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { JobSummary } from "../background-jobs/types.js";
import { appendEvent, eventsPath } from "../workflows/events.js";
import { createPendingDecision, decisionsDir } from "../workflows/decisions.js";
import { buildConsent } from "../workflows/grant.js";
import { launchRun } from "../workflows/launch.js";
import { mailboxDir, postRunNotification } from "../workflows/notify.js";
import { reconcileRuns } from "../workflows/reconcile.js";
import { startRunner } from "../workflows/runner.js";
import { createRun } from "../workflows/runtime.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import type { WorkflowRun, WorkflowStore } from "../workflows/store.js";
import { def, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const CLI = "/opt/agav/build/cli.js";
const DAY = 24 * 60 * 60 * 1000;
const jobDef = def([{ id: "a", type: "job", command: "echo hi" }]);
const approvalDef = def([{ id: "g", type: "approval", prompt: "ok?" }], { policies: { maxRuntimeSeconds: 60 } });

async function consented(definition: WorkflowDefinition = jobDef, mutate?: (run: WorkflowRun) => void): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "ask", []);
  mutate?.(run);
  await store.lock(run.id, () => store.save(run));
  return run;
}
async function save(run: WorkflowRun, mutate: (run: WorkflowRun) => void): Promise<WorkflowRun> {
  const current = await store.read(run.id, registry);
  mutate(current);
  await store.lock(run.id, () => store.save(current));
  return current;
}
function setRunnerState(coordinator: FakeCoordinator, requestId: string, state: JobSummary["state"]): void {
  const job = [...coordinator.jobs.values()].find(item => item.requestId === requestId)!;
  coordinator.jobs.set(job.jobId, { ...job, state });
}
async function exists(path: string): Promise<boolean> { return fs.access(path).then(() => true, () => false); }

describe("queued admission when a runner finishes", () => {
  it("a full pool admits the oldest queued run once the runner settles (its own exiting job holds no slot)", async () => {
    const runners = new FakeCoordinator();
    const first = await consented();
    const second = await consented();
    const deps = { coordinator: runners, cliPath: CLI, maxConcurrentWorkflowRuns: 1 };
    expect((await launchRun(store, first.id, deps)).status).toBe("started");
    expect((await launchRun(store, second.id, deps)).status).toBe("queued");

    // The first run's runner executes (its child job uses a separate coordinator) and finishes; its runner job is still "running".
    const jobs = new FakeCoordinator();
    const handle = startRunner(first.id, { store, registry, config: testConfig(), getCoordinator: async () => jobs, jobDepsOverrides: { pollIntervalMs: 5 }, admitQueued: deps });
    expect((await handle.done).status).toBe("passed");
    expect(runners.jobs.get("job-1")!.state).toBe("running");

    expect(runners.starts.map(request => request.requestId)).toEqual([`wf-run-${first.id}-1`, `wf-run-${second.id}-1`]);
    expect((await store.read(second.id, registry)).runner?.jobId).toBe("job-2");
  });

  it("without admitQueued the runner admits nothing", async () => {
    const runners = new FakeCoordinator();
    const first = await consented();
    const second = await consented();
    const deps = { coordinator: runners, cliPath: CLI, maxConcurrentWorkflowRuns: 1 };
    await launchRun(store, first.id, deps);
    await launchRun(store, second.id, deps);
    const handle = startRunner(first.id, { store, registry, config: testConfig(), getCoordinator: async () => new FakeCoordinator(), jobDepsOverrides: { pollIntervalMs: 5 } });
    await handle.done;
    expect(runners.starts).toHaveLength(1);
  });
});

describe("background tick reconciles workflow runs", () => {
  it("runs the workflow reconcile only when workflows are enabled and automation is not paused", async () => {
    const { runBackgroundTick } = await import("../background-jobs-integration.js");
    const engine = { evaluateOnce: vi.fn(async () => []) } as never;
    const session = { permissionMode: "auto-accept" as const, headlessApprovedActions: [] };
    const reconcileWorkflows = vi.fn(async () => {});
    await runBackgroundTick({ scheduleEngine: engine, session, reconcileWorkflows });
    expect(reconcileWorkflows).not.toHaveBeenCalled();
    await runBackgroundTick({ scheduleEngine: engine, session, workflows: { maxConcurrentWorkflowRuns: 3 }, reconcileWorkflows });
    expect(reconcileWorkflows).toHaveBeenCalledWith({ maxConcurrentWorkflowRuns: 3 });
    await runBackgroundTick({ scheduleEngine: engine, session, workflows: {}, reconcileWorkflows, backgroundAutomation: "paused" });
    expect(reconcileWorkflows).toHaveBeenCalledTimes(1);
  });
});

describe("launchRun with an uncertain runner", () => {
  it.each(["unknown", "recovery-required"] as const)("refuses attempt+1 while the runner is %s unless forced", async state => {
    const coordinator = new FakeCoordinator();
    const run = await consented();
    await launchRun(store, run.id, { coordinator, cliPath: CLI });
    await save(run, current => { current.status = "interrupted"; });
    setRunnerState(coordinator, `wf-run-${run.id}-1`, state);

    await expect(launchRun(store, run.id, { coordinator, cliPath: CLI })).rejects.toThrow(new RegExp(`is ${state} and may still be running`));
    expect(coordinator.starts).toHaveLength(1);
    expect((await store.read(run.id, registry)).runner).toMatchObject({ attempt: 1 });

    const forced = await launchRun(store, run.id, { coordinator, cliPath: CLI, force: true });
    expect(forced.status).toBe("started");
    expect(coordinator.starts.map(request => request.requestId)).toEqual([`wf-run-${run.id}-1`, `wf-run-${run.id}-2`]);
  });

  it("still starts attempt+1 after a definitely finished runner", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented();
    await launchRun(store, run.id, { coordinator, cliPath: CLI });
    await save(run, current => { current.status = "interrupted"; });
    setRunnerState(coordinator, `wf-run-${run.id}-1`, "failed");
    expect((await launchRun(store, run.id, { coordinator, cliPath: CLI })).status).toBe("started");
  });
});

describe("retention prune", () => {
  it("deletes terminal runs older than the retention window with all their files; never non-terminal runs", async () => {
    const coordinator = new FakeCoordinator();
    const done = await consented(jobDef, run => { run.status = "cancelled"; run.nodes[0]!.status = "cancelled"; });
    const parked = await consented(jobDef, run => { run.status = "interrupted"; });
    const other = await consented(jobDef, run => { run.status = "failed"; run.nodes[0]!.status = "failed"; });
    await appendEvent(store, done.id, { type: "run_status", status: "cancelled" });
    await createPendingDecision(store, done.id, { kind: "approval", nodeId: "a", summary: "x" });
    await fs.mkdir(join(store.runDir(done.id), "artifacts"), { recursive: true });
    await fs.writeFile(join(store.runDir(done.id), "artifacts", "a.json"), "{}");
    await store.requestCancel(done.id);
    const note = (await postRunNotification(store, await store.read(done.id, registry)))!;
    await fs.writeFile(join(mailboxDir(store), `${note.id}.seen`), "{}");
    const otherNote = (await postRunNotification(store, await store.read(other.id, registry)))!;

    // Within the window: nothing pruned.
    let results = await reconcileRuns(store, { coordinator, cliPath: CLI });
    expect(results.filter(result => result.action === "pruned")).toEqual([]);

    // A clock 8 days ahead puts both terminal runs past the default 7-day window; the interrupted run stays.
    results = await reconcileRuns(store, { coordinator, cliPath: CLI }, { now: Date.now() + 8 * DAY });
    expect(results).toContainEqual({ runId: done.id, action: "pruned" });
    expect(results).toContainEqual({ runId: other.id, action: "pruned" });
    expect(results.some(result => result.runId === parked.id && result.action === "pruned")).toBe(false);
    expect(await store.listIds()).toEqual([parked.id]);
    expect(await exists(store.runDir(done.id))).toBe(false);
    expect(await exists(eventsPath(store, done.id))).toBe(false);
    expect(await exists(decisionsDir(store, done.id))).toBe(false);
    expect(await store.cancellationRequested(done.id)).toBe(false);
    expect(await exists(join(mailboxDir(store), `${note.id}.json`))).toBe(false);
    expect(await exists(join(mailboxDir(store), `${note.id}.seen`))).toBe(false);
    expect(await exists(join(mailboxDir(store), `${otherNote.id}.json`))).toBe(false);
  });

  it("honors a custom retention window", async () => {
    const coordinator = new FakeCoordinator();
    const done = await consented(jobDef, run => { run.status = "passed"; run.nodes[0]!.status = "passed"; run.nodes[0]!.job = { requestId: `wf-${run.id}-a-1`, jobId: "x", state: "completed" }; });
    expect(await reconcileRuns(store, { coordinator, cliPath: CLI }, { now: Date.now() + 8 * DAY, retentionDays: 30 })).toEqual([]);
    expect(await reconcileRuns(store, { coordinator, cliPath: CLI }, { now: Date.now() + 31 * DAY, retentionDays: 30 })).toEqual([{ runId: done.id, action: "pruned" }]);
  });
});

describe("parked run past its deadline", () => {
  async function parkedPastDeadline(coordinator: FakeCoordinator, runnerState: JobSummary["state"]): Promise<WorkflowRun> {
    const run = await consented(approvalDef);
    await launchRun(store, run.id, { coordinator, cliPath: CLI });
    setRunnerState(coordinator, `wf-run-${run.id}-1`, runnerState);
    return save(run, current => {
      current.status = "waiting_approval";
      current.nodes[0]!.status = "waiting_approval";
      current.deadlineAt = new Date(Date.now() - 1000).toISOString();
    });
  }

  it("is marked timed_out when no runner is live", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parkedPastDeadline(coordinator, "completed");
    expect(await reconcileRuns(store, { coordinator, cliPath: CLI })).toContainEqual({ runId: run.id, action: "timed_out" });
    expect((await store.read(run.id, registry)).status).toBe("timed_out");
    expect(coordinator.starts).toHaveLength(1);
    expect((await fs.readdir(mailboxDir(store))).length).toBe(1);
  });

  it("is left alone while its runner is still live, and before the deadline", async () => {
    const coordinator = new FakeCoordinator();
    const live = await parkedPastDeadline(coordinator, "running");
    const results = await reconcileRuns(store, { coordinator, cliPath: CLI });
    expect(results.find(result => result.runId === live.id)?.action).toBe("none");
    expect((await store.read(live.id, registry)).status).toBe("waiting_approval");

    const future = await consented(approvalDef, run => { run.status = "waiting_approval"; run.nodes[0]!.status = "waiting_approval"; run.deadlineAt = new Date(Date.now() + 60_000).toISOString(); });
    await reconcileRuns(store, { coordinator, cliPath: CLI });
    expect((await store.read(future.id, registry)).status).toBe("waiting_approval");
  });
});
