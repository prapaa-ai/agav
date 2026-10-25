import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInvoker } from "../workflows/agent-invoker.js";
import { cancelRun } from "../workflows/control.js";
import { createPendingDecision, decide, decisionsDir, listDecisions, listPendingDecisions, readDecision } from "../workflows/decisions.js";
import { validateDefinition, type WorkflowDefinition } from "../workflows/definition.js";
import { JobCancellationIncompleteError } from "../workflows/job-node.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { jobRequestId, type LoopNodeCheckpoint, type WorkflowRun, type WorkflowStore } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, jobDeps, registry, summary, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });
const config = testConfig();

const create = (definition: WorkflowDefinition): Promise<WorkflowRun> => createRun(store, validateDefinition(definition, registry), {});
const runPath = (id: string): string => join(store.root, `${id}.json`);
const rawRun = async (id: string): Promise<WorkflowRun> => JSON.parse(await readFile(runPath(id), "utf8")) as WorkflowRun;
const writeRaw = (run: WorkflowRun): Promise<void> => writeFile(runPath(run.id), JSON.stringify(run));
const loopCp = (run: WorkflowRun, id = "fix"): LoopNodeCheckpoint => run.nodes.find(cp => cp.id === id) as LoopNodeCheckpoint;
const agentDeps = (inv: AgentInvoker) => ({ getInvoker: () => inv, loadAgents: async () => [] });

describe("loop iteration settlement with an outstanding approval", () => {
  const body = [
    { id: "gate", type: "approval" as const, prompt: "go?" },
    { id: "work", type: "prompt" as const, prompt: "work" },
  ];

  it("settles a waiting approval when an independent body node fails", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, body: [body[0]!, { id: "work", type: "tool", tool: "read_file", input: { path: "p" } }] }]));
    const host = fakeHost({ read_file: { output: "boom", isError: true } });
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("failed");
    const read = await store.read(run.id, registry); // used to reject: terminal iteration with a waiting_approval node
    const it = loopCp(read).iterations![0]!;
    expect(it.status).toBe("failed");
    expect(it.nodes.work!.status).toBe("failed");
    expect(it.nodes.gate).toMatchObject({ status: "cancelled" });
    expect(it.nodes.gate!.decisionId).toBeUndefined();
    expect(loopCp(read).status).toBe("failed");
    // The unusable approval is durably settled, not left in the inbox.
    expect(await listPendingDecisions(store, run.id)).toEqual([]);
    expect(await listDecisions(store, run.id)).toMatchObject([{ pending: { nodeId: "gate" }, decided: { decision: "deny", decidedBy: "workflow-runtime" } }]);
  });

  it("settles a waiting approval nested in an inner loop when the outer iteration fails", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, body: [
      { id: "inner", type: "loop", maxIterations: 1, body: [body[0]!] },
      { id: "work", type: "tool", tool: "read_file", input: { path: "p" } },
    ] }]));
    const host = fakeHost({ read_file: { output: "boom", isError: true } });
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("failed");
    const read = await store.read(run.id, registry);
    const outer = loopCp(read).iterations![0]!;
    expect(outer.status).toBe("failed");
    const inner = outer.nodes.inner as LoopNodeCheckpoint;
    expect(inner.iterations![0]).toMatchObject({ status: "cancelled", nodes: { gate: { status: "cancelled" } } });
    expect(await listPendingDecisions(store, run.id)).toEqual([]);
    expect(await listDecisions(store, run.id)).toHaveLength(1);
  });

  it("keeps the checkpoint readable and the decision retryable when settling the decision fails", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, body: [body[0]!, { id: "work", type: "tool", tool: "read_file", input: { path: "p" } }] }]));
    const host = fakeHost({ read_file: { output: "boom", isError: true } });
    // The approval's decided path is occupied by a directory, so the deny write cannot succeed.
    const { decisionId } = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", summary: "go?", discriminator: "iteration:0" });
    await mkdir(join(decisionsDir(store, run.id), `${decisionId}.decided.json`), { recursive: true });
    await expect(executeRun(store, run.id, registry, config, undefined, host)).rejects.toThrow();
    const read = await store.read(run.id, registry);
    expect(read.status).not.toBe("failed");
    const it = loopCp(read).iterations![0]!;
    expect(it.status).not.toBe("failed");
    expect(it.nodes.gate).toMatchObject({ status: "waiting_approval", decisionId });
    expect((await readDecision(store, run.id, decisionId).catch(() => undefined))?.decided).toBeUndefined();
  });

  it("settles a waiting approval when an independent body node is cancelled", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, body }]));
    const controller = new AbortController();
    const inv: AgentInvoker = {
      async invoke(req) {
        controller.abort();
        if (!req.signal!.aborted) await new Promise(resolve => req.signal!.addEventListener("abort", resolve, { once: true }));
        return { text: "late", durationMs: 1 };
      },
    };
    const done = await executeRun(store, run.id, registry, config, controller.signal, fakeHost(), undefined, agentDeps(inv));
    expect(done.status).toBe("cancelled");
    const read = await store.read(run.id, registry);
    const it = loopCp(read).iterations![0]!;
    expect(it.status).toBe("cancelled");
    expect(it.nodes.gate!.status).toBe("cancelled");
    expect(loopCp(read).status).toBe("cancelled");
    expect(await listPendingDecisions(store, run.id)).toEqual([]);
  });

  it("keeps a parked loop readable (not terminal) next to an independent failure under stopOnFailure:false", async () => {
    const run = await create(def([
      { id: "park", type: "loop", maxIterations: 1, body: [{ id: "gate", type: "approval", prompt: "go?" }] },
      { id: "bad", type: "tool", tool: "read_file", input: { path: "p" } },
    ], { policies: { stopOnFailure: false } }));
    const host = fakeHost({ read_file: { output: "boom", isError: true } });
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    // stopOnFailure:false keeps independent parked work alive: nothing here is terminal, so it stays readable.
    expect(done.status).toBe("waiting_approval");
    await expect(store.read(run.id, registry)).resolves.toBeTruthy();
    expect(await listPendingDecisions(store, run.id)).toHaveLength(1);
  });
});

describe("resumed run terminalized by an earlier denial", () => {
  const jobNodes = [
    { id: "gate", type: "approval" as const, prompt: "go?" },
    { id: "j", type: "job" as const, command: "sleep 100" },
  ];

  /** Resumable checkpoint: gate parked on a decision (denied before resume), independent job still running. */
  async function seed(definition: WorkflowDefinition, coordinator: FakeCoordinator, jobAt: "root" | "loop"): Promise<WorkflowRun> {
    const run = await create(definition);
    const raw = await rawRun(run.id);
    const pending = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "gate", summary: "go?" });
    await decide(store, run.id, pending.decisionId, false, "tester");
    coordinator.pollStates = ["running"];
    const t = new Date().toISOString();
    raw.status = "waiting_approval";
    raw.nodes[0] = { id: "gate", status: "waiting_approval", decisionId: pending.decisionId, startedAt: t };
    if (jobAt === "root") {
      const requestId = jobRequestId(run.id, "j", 1);
      coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
      raw.nodes[1] = { id: "j", status: "running", startedAt: t, job: { requestId, jobId: "job-9", state: "running" } };
    } else {
      const scope = { loopPath: [{ loopId: "fix", iteration: 0 }] };
      const requestId = jobRequestId(run.id, "build", 1, scope);
      coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
      raw.nodes[1] = { id: "fix", status: "running", startedAt: t, iteration: 0, iterations: [
        { index: 0, status: "running", startedAt: t, nodes: { build: { id: "build", status: "running", startedAt: t, job: { requestId, jobId: "job-9", state: "running" } } } },
      ] } as LoopNodeCheckpoint;
    }
    await writeRaw(raw);
    return run;
  }

  it("stops the live job before the failed run goes terminal, so cancel still sees the settled state", async () => {
    const coordinator = new FakeCoordinator();
    const run = await seed(def(jobNodes), coordinator, "root");
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(coordinator.stops).toEqual(["job-9"]);
    expect(coordinator.starts).toHaveLength(0);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.status).toBe("failed");
    expect(done.nodes[1]!.status).toBe("cancelled");
    expect((await store.read(run.id, registry)).nodes[1]!.job).toMatchObject({ jobId: "job-9", state: "interrupted" });
  });

  it("stops a live job nested in a loop body and settles the loop", async () => {
    const coordinator = new FakeCoordinator();
    const run = await seed(def([jobNodes[0]!, { id: "fix", type: "loop", maxIterations: 2, body: [{ id: "build", type: "job", command: "make" }] }]), coordinator, "loop");
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(coordinator.stops).toEqual(["job-9"]);
    expect(done.status).toBe("failed");
    const read = await store.read(run.id, registry);
    const loop = loopCp(read);
    expect(loop.status).toBe("cancelled");
    expect(loop.iterations![0]).toMatchObject({ status: "cancelled", nodes: { build: { status: "cancelled" } } });
  });

  it("stays non-terminal and keeps the job linkage when the stop is not confirmed", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.stop = async () => { throw new Error("stop denied"); };
    const run = await seed(def(jobNodes), coordinator, "root");
    await expect(executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator))).rejects.toBeInstanceOf(JobCancellationIncompleteError);
    const read = await store.read(run.id, registry);
    expect(read.status).toBe("waiting_approval");
    expect(read.nodes[1]).toMatchObject({ status: "running", job: { jobId: "job-9" } });
    // A later cancel from a context that can stop the job still works: the run was never made terminal.
    const healthy = new FakeCoordinator();
    healthy.jobs.set("job-9", coordinator.jobs.get("job-9")!);
    healthy.pollStates = ["running"];
    const cancelled = await cancelRun(store, run.id, registry, undefined, jobDeps(healthy));
    expect(healthy.stops).toEqual(["job-9"]);
    expect(cancelled.status).toBe("cancelled");
  });

  it("does not terminalize without job support while a job may be live", async () => {
    const coordinator = new FakeCoordinator();
    const run = await seed(def(jobNodes), coordinator, "root");
    await expect(executeRun(store, run.id, registry, config, undefined, fakeHost())).rejects.toThrow(/background-job support/);
    const read = await store.read(run.id, registry);
    expect(read.status).toBe("waiting_approval");
    expect(read.nodes[1]!.status).toBe("running");
  });
});
