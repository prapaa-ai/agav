import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPendingDecision, decide, listDecisions, listPendingDecisions } from "../workflows/decisions.js";
import { validateDefinition, type WorkflowDefinition } from "../workflows/definition.js";
import { JobCancellationIncompleteError } from "../workflows/job-node.js";
import { createRun, executeRun, MAX_EXECUTIONS } from "../workflows/runtime.js";
import { jobRequestId, type LoopNodeCheckpoint, type WorkflowRun, type WorkflowStore } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, jobDeps, registry, summary, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });
const config = testConfig();

const runPath = (id: string): string => join(store.root, `${id}.json`);
const rawRun = async (id: string): Promise<WorkflowRun> => JSON.parse(await readFile(runPath(id), "utf8")) as WorkflowRun;
const writeRaw = (run: WorkflowRun): Promise<void> => writeFile(runPath(run.id), JSON.stringify(run));
const loopCp = (run: WorkflowRun, id: string): LoopNodeCheckpoint => run.nodes.find(cp => cp.id === id) as LoopNodeCheckpoint;

/**
 * Two independent root loops, both `running` when the runner died: `first` has a finished iteration (its stop condition
 * holds), `second` has a live job (plus, optionally, a gate parked on a decision) in its running iteration.
 */
async function seed(coordinator: FakeCoordinator, options: { gate?: boolean; executionCount?: number } = {}): Promise<{ run: WorkflowRun; decisionId?: string }> {
  const definition: WorkflowDefinition = def([
    { id: "first", type: "loop", maxIterations: 2, until: "nodes.a.output == 'done'", body: [{ id: "a", type: "prompt", prompt: "A" }] },
    { id: "second", type: "loop", maxIterations: 1, onExhausted: "continue", body: [
      ...(options.gate ? [{ id: "gate", type: "approval" as const, prompt: "go?" }] : []),
      { id: "build", type: "job", command: "sleep 100" },
    ] },
  ]);
  const run = await createRun(store, validateDefinition(definition, registry), {});
  const raw = await rawRun(run.id);
  const t = new Date().toISOString();
  const scope = { loopPath: [{ loopId: "second", iteration: 0 }] };
  const requestId = jobRequestId(run.id, "build", 1, scope);
  coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
  coordinator.pollStates = ["running", "completed"];
  let decisionId: string | undefined;
  const nodes: LoopNodeCheckpoint["iterations"] = [{ index: 0, status: "running", startedAt: t, nodes: {
    build: { id: "build", status: "running", startedAt: t, job: { requestId, jobId: "job-9", state: "running" } },
  } }];
  if (options.gate) {
    decisionId = (await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", iteration: [0], summary: "go?" })).decisionId;
    nodes![0]!.nodes.gate = { id: "gate", status: "waiting_approval", decisionId, startedAt: t };
  }
  raw.status = "running";
  raw.executionCount = options.executionCount ?? 0;
  raw.nodes[0] = { id: "first", status: "running", startedAt: t, iteration: 0, iterations: [
    { index: 0, status: "running", startedAt: t, nodes: { a: { id: "a", status: "passed", output: "done" } } },
  ] } as LoopNodeCheckpoint;
  raw.nodes[1] = { id: "second", status: "running", startedAt: t, iteration: 0, iterations: nodes } as LoopNodeCheckpoint;
  await writeRaw(raw);
  return { run, decisionId };
}

describe("resume with several running root loops", () => {
  it("reattaches the running job of the second loop instead of stranding it", async () => {
    const coordinator = new FakeCoordinator();
    const { run } = await seed(coordinator);
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(coordinator.starts).toHaveLength(0);
    expect(done.status).toBe("passed");
    const read = await store.read(run.id, registry);
    expect(loopCp(read, "second").status).toBe("passed");
    expect(loopCp(read, "second").iterations![0]!.nodes.build).toMatchObject({ status: "passed", job: { jobId: "job-9" } });
  });
});

describe("execution cap on a resumed loop with live work", () => {
  it("settles parked sibling loops without live jobs before ending a capped run", async () => {
    const definition = def(["first", "second"].map(id => ({ id, type: "loop" as const, maxIterations: 1, body: [{ id: `${id}Gate`, type: "approval" as const, prompt: "go?" }] })));
    const run = await createRun(store, definition, {});
    await executeRun(store, run.id, registry, config, undefined, fakeHost());
    const pending = await listPendingDecisions(store, run.id);
    expect(pending).toHaveLength(2);
    await decide(store, run.id, pending.find(p => p.nodeId === "firstGate")!.decisionId, true, "tester");
    const raw = await rawRun(run.id);
    raw.executionCount = MAX_EXECUTIONS;
    await writeRaw(raw);
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost());
    expect(done.status).toBe("failed");
    expect(await listPendingDecisions(store, run.id)).toEqual([]);
    const read = await store.read(run.id, registry);
    for (const cp of read.nodes as LoopNodeCheckpoint[]) {
      expect(["passed", "failed", "cancelled"]).toContain(cp.status);
      for (const iteration of cp.iterations ?? []) {
        expect(["passed", "failed", "cancelled"]).toContain(iteration.status);
        expect(Object.values(iteration.nodes).some(child => child.status === "waiting_approval")).toBe(false);
      }
    }
  });
  it("stops the live job and settles iterations and decisions before failing the loop", async () => {
    const coordinator = new FakeCoordinator();
    const { run } = await seed(coordinator, { gate: true, executionCount: MAX_EXECUTIONS });
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(done.status).toBe("failed");
    expect(coordinator.stops).toEqual(["job-9"]);
    const read = await store.read(run.id, registry); // used to reject: failed loop with a running iteration
    const loop = loopCp(read, "second");
    expect(loop).toMatchObject({ status: "failed", error: expect.stringMatching(/execution cap/) });
    const it = loop.iterations![0]!;
    expect(it.status).toBe("cancelled");
    expect(it.nodes.build!.status).toBe("cancelled");
    expect(it.nodes.gate).toMatchObject({ status: "cancelled" });
    expect(await listPendingDecisions(store, run.id)).toEqual([]);
    expect(await listDecisions(store, run.id)).toMatchObject([{ decided: { decision: "deny" } }]);
  });

  it("fails closed (non-terminal, linkage kept) when the stop is not confirmed", async () => {
    const coordinator = new FakeCoordinator();
    const { run } = await seed(coordinator, { gate: true, executionCount: MAX_EXECUTIONS });
    coordinator.stop = async () => { throw new Error("stop denied"); };
    coordinator.pollStates = ["running"];
    await expect(executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator))).rejects.toBeInstanceOf(JobCancellationIncompleteError);
    const read = await store.read(run.id, registry);
    expect(read.status).not.toBe("failed");
    expect(loopCp(read, "second").status).toBe("running");
    expect(loopCp(read, "second").iterations![0]!.nodes.build).toMatchObject({ status: "running", job: { jobId: "job-9" } });
    expect(await listPendingDecisions(store, run.id)).toHaveLength(1);
  });

  it("does not terminalize without job support while a job may be live", async () => {
    const coordinator = new FakeCoordinator();
    const { run } = await seed(coordinator, { executionCount: MAX_EXECUTIONS });
    await expect(executeRun(store, run.id, registry, config, undefined, fakeHost())).rejects.toThrow(/background-job support/);
    const read = await store.read(run.id, registry);
    expect(read.status).not.toBe("failed");
    expect(loopCp(read, "second").iterations![0]!.nodes.build!.status).toBe("running");
  });
});

describe("resume with several running loops nested in one loop body", () => {
  it("re-enters the second inner loop and reattaches its live job instead of failing it as uncertain", async () => {
    const coordinator = new FakeCoordinator();
    const definition: WorkflowDefinition = def([
      { id: "outer", type: "loop", maxIterations: 1, onExhausted: "continue", body: [
        { id: "innerA", type: "loop", maxIterations: 1, onExhausted: "continue", body: [{ id: "gate", type: "approval", prompt: "go?" }] },
        { id: "innerB", type: "loop", maxIterations: 1, onExhausted: "continue", body: [{ id: "build", type: "job", command: "sleep 100" }] },
      ] },
    ]);
    const run = await createRun(store, validateDefinition(definition, registry), {});
    const raw = await rawRun(run.id);
    const t = new Date().toISOString();
    const requestId = jobRequestId(run.id, "build", 1, { loopPath: [{ loopId: "outer", iteration: 0 }, { loopId: "innerB", iteration: 0 }] });
    coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
    coordinator.pollStates = ["running", "completed"];
    const { decisionId } = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", iteration: [0, 0], summary: "go?" });
    await decide(store, run.id, decisionId, true, "tester");
    const innerA: LoopNodeCheckpoint = { id: "innerA", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { gate: { id: "gate", status: "waiting_approval", decisionId, startedAt: t } } },
    ] };
    const innerB: LoopNodeCheckpoint = { id: "innerB", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { build: { id: "build", status: "running", startedAt: t, job: { requestId, jobId: "job-9", state: "running" } } } },
    ] };
    raw.status = "running";
    raw.nodes[0] = { id: "outer", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { innerA, innerB } },
    ] } as LoopNodeCheckpoint;
    await writeRaw(raw);

    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(coordinator.starts).toHaveLength(0);
    expect(coordinator.stops).toEqual([]);
    expect(done.status).toBe("passed");
    const read = await store.read(run.id, registry);
    const outer = loopCp(read, "outer").iterations![0]!;
    expect(outer.nodes.innerA).toMatchObject({ status: "passed" });
    expect(outer.nodes.innerB).toMatchObject({ status: "passed" });
    expect((outer.nodes.innerB as LoopNodeCheckpoint).iterations![0]!.nodes.build).toMatchObject({ status: "passed", job: { jobId: "job-9" } });
  });
});

describe("resume where the first nested loop fails while a second nested loop owns a live job", () => {
  /** `outer` body: `innerA` (gate with a denied decision, fails on resume) then `innerB` (live job); both were running at the crash. */
  async function seedNested(coordinator: FakeCoordinator): Promise<{ run: WorkflowRun; gateDecision: string }> {
    const definition: WorkflowDefinition = def([
      { id: "outer", type: "loop", maxIterations: 1, onExhausted: "continue", body: [
        { id: "innerA", type: "loop", maxIterations: 1, onExhausted: "continue", body: [{ id: "gate", type: "approval", prompt: "go?" }] },
        { id: "innerB", type: "loop", maxIterations: 1, onExhausted: "continue", body: [{ id: "build", type: "job", command: "sleep 100" }] },
      ] },
    ]);
    const run = await createRun(store, validateDefinition(definition, registry), {});
    const raw = await rawRun(run.id);
    const t = new Date().toISOString();
    const requestId = jobRequestId(run.id, "build", 1, { loopPath: [{ loopId: "outer", iteration: 0 }, { loopId: "innerB", iteration: 0 }] });
    coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
    coordinator.pollStates = ["running"];
    const { decisionId } = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", iteration: [0, 0], summary: "go?" });
    await decide(store, run.id, decisionId, false, "tester");
    const innerA: LoopNodeCheckpoint = { id: "innerA", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { gate: { id: "gate", status: "waiting_approval", decisionId, startedAt: t } } },
    ] };
    const innerB: LoopNodeCheckpoint = { id: "innerB", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { build: { id: "build", status: "running", startedAt: t, job: { requestId, jobId: "job-9", state: "running" } } } },
    ] };
    raw.status = "running";
    raw.nodes[0] = { id: "outer", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { innerA, innerB } },
    ] } as LoopNodeCheckpoint;
    await writeRaw(raw);
    return { run, gateDecision: decisionId };
  }

  it("stops the second loop's live job (confirmed) before the outer loop and run turn terminal", async () => {
    const coordinator = new FakeCoordinator();
    const { run } = await seedNested(coordinator);
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(done.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
    expect(coordinator.stops).toEqual(["job-9"]);
    const read = await store.read(run.id, registry); // used to reject: failed iteration holding a running nested loop
    const outer = loopCp(read, "outer");
    expect(outer.status).toBe("failed");
    const it = outer.iterations![0]!;
    expect(it.status).toBe("failed");
    expect(it.nodes.innerA).toMatchObject({ status: "failed" });
    const innerB = it.nodes.innerB as LoopNodeCheckpoint;
    expect(["cancelled", "failed"]).toContain(innerB.status);
    expect(["cancelled", "failed"]).toContain(innerB.iterations![0]!.status);
    expect(innerB.iterations![0]!.nodes.build!.status).not.toBe("running");
  });

  it("keeps the run non-terminal and the job linkage when the stop is not confirmed", async () => {
    const coordinator = new FakeCoordinator();
    const { run } = await seedNested(coordinator);
    coordinator.stop = async () => { throw new Error("stop denied"); };
    await expect(executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator))).rejects.toBeInstanceOf(JobCancellationIncompleteError);
    const read = await store.read(run.id, registry); // must stay readable
    expect(read.status).not.toBe("failed");
    const outer = loopCp(read, "outer");
    expect(outer.status).toBe("running");
    expect(outer.iterations![0]!.status).toBe("running");
    const innerB = outer.iterations![0]!.nodes.innerB as LoopNodeCheckpoint;
    expect(innerB.status).toBe("running");
    expect(innerB.iterations![0]!.nodes.build).toMatchObject({ status: "running", job: { jobId: "job-9" } });
  });
});

describe("resume with a running nested loop and a sibling direct job in one loop body", () => {
  type Order = "loop-first" | "job-first";
  const orders: Order[] = ["loop-first", "job-first"];
  /**
   * `outer` body holds a nested loop `inner` (a gate) and a direct job `build`; both were `running` when the runner died
   * (only the job owns a workload). The gate decision is already decided (`approve`). `buildTimeout` makes the reattached job
   * time out immediately, so it must be stopped (and the stop can be left unconfirmed).
   */
  async function seedSibling(coordinator: FakeCoordinator, order: Order, options: { approve: boolean; buildTimeout?: boolean }): Promise<WorkflowRun> {
    const inner = { id: "inner", type: "loop" as const, maxIterations: 1, onExhausted: "continue" as const, body: [{ id: "gate", type: "approval" as const, prompt: "go?" }] };
    const build = { id: "build", type: "job" as const, command: "sleep 100", ...(options.buildTimeout ? { timeoutSeconds: 1 } : {}) };
    const run = await createRun(store, validateDefinition(def([
      { id: "outer", type: "loop", maxIterations: 1, onExhausted: "continue", body: order === "loop-first" ? [inner, build] : [build, inner] },
    ]), registry), {});
    const raw = await rawRun(run.id);
    const t = new Date().toISOString();
    const startedAt = options.buildTimeout ? new Date(Date.now() - 60_000).toISOString() : t;
    const requestId = jobRequestId(run.id, "build", 1, { loopPath: [{ loopId: "outer", iteration: 0 }] });
    coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
    const { decisionId } = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", iteration: [0, 0], summary: "go?" });
    await decide(store, run.id, decisionId, options.approve, "tester");
    const innerCp: LoopNodeCheckpoint = { id: "inner", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { gate: { id: "gate", status: "waiting_approval", decisionId, startedAt: t } } },
    ] };
    const buildCp = { id: "build", status: "running" as const, startedAt, job: { requestId, jobId: "job-9", state: "running" as const } };
    raw.status = "running";
    raw.nodes[0] = { id: "outer", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: order === "loop-first" ? { inner: innerCp, build: buildCp } : { build: buildCp, inner: innerCp } },
    ] } as LoopNodeCheckpoint;
    await writeRaw(raw);
    return run;
  }

  for (const order of orders) {
    it(`reattaches the direct job and re-enters the passing nested loop (${order})`, async () => {
      const coordinator = new FakeCoordinator();
      const run = await seedSibling(coordinator, order, { approve: true });
      const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
      expect(coordinator.starts).toHaveLength(0);
      expect(coordinator.stops).toEqual([]);
      expect(done.status).toBe("passed");
      const it0 = loopCp(await store.read(run.id, registry), "outer").iterations![0]!;
      expect(it0.nodes.build).toMatchObject({ status: "passed", job: { jobId: "job-9" } });
      expect(it0.nodes.inner).toMatchObject({ status: "passed" });
    });

    it(`reattaches the direct job (never failed as uncertain) when the nested loop fails (${order})`, async () => {
      const coordinator = new FakeCoordinator();
      const run = await seedSibling(coordinator, order, { approve: false });
      const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
      expect(coordinator.starts).toHaveLength(0);
      expect(done.status).toBe("failed");
      const read = await store.read(run.id, registry); // must stay readable
      const it0 = loopCp(read, "outer").iterations![0]!;
      expect(it0.status).toBe("failed");
      expect(it0.nodes.inner).toMatchObject({ status: "failed" });
      expect(it0.nodes.build).toMatchObject({ status: "passed", job: { jobId: "job-9" } });
      expect(it0.nodes.build!.error).toBeUndefined();
    });

    it(`stops the reattached job with a confirmed stop when it times out (${order})`, async () => {
      const coordinator = new FakeCoordinator();
      const run = await seedSibling(coordinator, order, { approve: true, buildTimeout: true });
      coordinator.pollStates = ["running"];
      const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
      expect(coordinator.starts).toHaveLength(0);
      expect(coordinator.stops).toEqual(["job-9"]);
      expect(done.status).toBe("timed_out");
      const it0 = loopCp(await store.read(run.id, registry), "outer").iterations![0]!;
      expect(it0.nodes.build).toMatchObject({ status: "timed_out", job: { jobId: "job-9" } });
    });

    it(`keeps the run non-terminal and the job linkage when that stop is not confirmed (${order})`, async () => {
      const coordinator = new FakeCoordinator();
      const run = await seedSibling(coordinator, order, { approve: false, buildTimeout: true });
      coordinator.pollStates = ["running"];
      coordinator.stop = async () => { throw new Error("stop denied"); };
      await expect(executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator))).rejects.toBeInstanceOf(JobCancellationIncompleteError);
      expect(coordinator.starts).toHaveLength(0);
      const read = await store.read(run.id, registry); // must stay readable
      expect(read.status).not.toBe("failed");
      const outer = loopCp(read, "outer");
      expect(outer.status).toBe("running");
      expect(outer.iterations![0]!.status).toBe("running");
      expect(outer.iterations![0]!.nodes.build).toMatchObject({ status: "running", job: { jobId: "job-9" } });
    });
  }
});

describe("resume with a running root loop and a sibling direct root job", () => {
  type Order = "loop-first" | "job-first";
  const orders: Order[] = ["loop-first", "job-first"];
  /** Root `gate` loop (decision already decided) and a direct root job `build`, both `running` when the runner died. */
  async function seedRoot(coordinator: FakeCoordinator, order: Order, options: { approve: boolean; executionCount?: number }): Promise<WorkflowRun> {
    const loop = { id: "gateLoop", type: "loop" as const, maxIterations: 1, onExhausted: "continue" as const, body: [{ id: "gate", type: "approval" as const, prompt: "go?" }] };
    const build = { id: "build", type: "job" as const, command: "sleep 100" };
    const run = await createRun(store, validateDefinition(def(order === "loop-first" ? [loop, build] : [build, loop]), registry), {});
    const raw = await rawRun(run.id);
    const t = new Date().toISOString();
    const requestId = jobRequestId(run.id, "build", 1);
    coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
    coordinator.pollStates = ["running", "completed"];
    const { decisionId } = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", iteration: [0], summary: "go?" });
    await decide(store, run.id, decisionId, options.approve, "tester");
    const loopNode: LoopNodeCheckpoint = { id: "gateLoop", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { gate: { id: "gate", status: "waiting_approval", decisionId, startedAt: t } } },
    ] };
    const buildCp = { id: "build", status: "running" as const, startedAt: t, job: { requestId, jobId: "job-9", state: "running" as const } };
    raw.status = "running";
    raw.executionCount = options.executionCount ?? 0;
    raw.nodes = order === "loop-first" ? [loopNode, buildCp] : [buildCp, loopNode];
    await writeRaw(raw);
    return run;
  }

  for (const order of orders) {
    it(`reattaches the direct job and re-enters the passing loop (${order})`, async () => {
      const coordinator = new FakeCoordinator();
      const run = await seedRoot(coordinator, order, { approve: true });
      const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
      expect(coordinator.starts).toHaveLength(0);
      expect(coordinator.stops).toEqual([]);
      expect(done.status).toBe("passed");
      const read = await store.read(run.id, registry);
      expect(read.nodes.find(cp => cp.id === "build")).toMatchObject({ status: "passed", job: { jobId: "job-9" } });
      expect(loopCp(read, "gateLoop").status).toBe("passed");
    });

    it(`reattaches the direct job (never left unobserved) when the loop fails (${order})`, async () => {
      const coordinator = new FakeCoordinator();
      const run = await seedRoot(coordinator, order, { approve: false });
      const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
      expect(coordinator.starts).toHaveLength(0);
      expect(done.status).toBe("failed");
      const read = await store.read(run.id, registry);
      expect(read.nodes.find(cp => cp.id === "build")).toMatchObject({ status: "passed", job: { jobId: "job-9" } });
      expect(loopCp(read, "gateLoop").status).toBe("failed");
    });

    it(`never fails the reattached job as capped, and caps the loop afterwards (${order})`, async () => {
      const coordinator = new FakeCoordinator();
      const run = await seedRoot(coordinator, order, { approve: true, executionCount: MAX_EXECUTIONS });
      const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
      expect(coordinator.starts).toHaveLength(0);
      expect(done.status).toBe("failed");
      const read = await store.read(run.id, registry);
      expect(read.nodes.find(cp => cp.id === "build")).toMatchObject({ status: "passed", job: { jobId: "job-9" } });
      expect(read.nodes.find(cp => cp.id === "build")!.error).toBeUndefined();
    });
  }

  it("still reattaches a running root loop at the cap when no job is running (loop is the fallback slot)", async () => {
    const loop = { id: "gateLoop", type: "loop" as const, maxIterations: 1, onExhausted: "continue" as const, body: [{ id: "gate", type: "approval" as const, prompt: "go?" }] };
    const run = await createRun(store, validateDefinition(def([loop]), registry), {});
    const raw = await rawRun(run.id);
    const t = new Date().toISOString();
    const { decisionId } = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", iteration: [0], summary: "go?" });
    await decide(store, run.id, decisionId, true, "tester");
    raw.status = "running";
    raw.executionCount = MAX_EXECUTIONS;
    raw.nodes[0] = { id: "gateLoop", status: "running", startedAt: t, iteration: 0, iterations: [
      { index: 0, status: "running", startedAt: t, nodes: { gate: { id: "gate", status: "waiting_approval", decisionId, startedAt: t } } },
    ] } as LoopNodeCheckpoint;
    await writeRaw(raw);
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost());
    expect(done.status).toBe("passed"); // not failed by the cap: the resumed loop is exempt like a reattached job
    expect(loopCp(await store.read(run.id, registry), "gateLoop").status).toBe("passed");
  });
});
