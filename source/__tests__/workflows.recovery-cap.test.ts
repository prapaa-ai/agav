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
