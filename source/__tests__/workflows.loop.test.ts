import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { AgentInvokeRequest, AgentInvoker } from "../workflows/agent-invoker.js";
import type { AgentNodeDeps } from "../workflows/agent-node.js";
import { validateDefinition, type WorkflowDefinition } from "../workflows/definition.js";
import { readEvents } from "../workflows/events.js";
import { cancelRun } from "../workflows/control.js";
import { decide, listPendingDecisions } from "../workflows/decisions.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { readFile } from "node:fs/promises";
import { specPath } from "../background-jobs/storage/paths.js";
import { join } from "node:path";
import { jobRequestId, MAX_INLINE_OUTPUT_BYTES, type LoopNodeCheckpoint, type WorkflowRun, type WorkflowStore } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, jobDeps, registry, summary, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });
const config = testConfig();

type Reply = string | ((req: AgentInvokeRequest, call: number) => string);
/** Mock invoker: records every request; replies are taken in order (the last repeats). */
function mockInvoker(...replies: Reply[]): AgentInvoker & { requests: AgentInvokeRequest[] } {
  const requests: AgentInvokeRequest[] = [];
  return {
    requests,
    async invoke(req) {
      requests.push(req);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)] ?? "ok";
      return { text: typeof reply === "function" ? reply(req, requests.length) : reply, durationMs: 1 };
    },
  };
}
const agentDeps = (inv: AgentInvoker): AgentNodeDeps => ({ getInvoker: () => inv, loadAgents: async () => [] });
async function create(definition: WorkflowDefinition): Promise<WorkflowRun> {
  return createRun(store, validateDefinition(definition, registry), {});
}
async function execute(id: string, opts: { inv?: AgentInvoker; coordinator?: FakeCoordinator } = {}): Promise<WorkflowRun> {
  const done = await executeRun(store, id, registry, config, undefined, fakeHost(), opts.coordinator ? jobDeps(opts.coordinator) : undefined, opts.inv ? agentDeps(opts.inv) : undefined);
  // Every settled checkpoint must be readable again (store validation of loop iterations).
  await expect(store.read(id, registry)).resolves.toBeTruthy();
  return done;
}
const loopCp = (run: WorkflowRun, id = "fix") => run.nodes.find(cp => cp.id === id) as LoopNodeCheckpoint;
const check = (extra: Record<string, unknown> = {}) => ({ id: "check", type: "prompt" as const, prompt: "run the checks", output: "json" as const, ...extra });

describe("loop execution", () => {
  it("stops at the iteration where until becomes true", async () => {
    const inv = mockInvoker('{"passing":false}', '{"passing":false}', '{"passing":true}');
    const run = await create(def([
      { id: "fix", type: "loop", maxIterations: 5, until: "nodes.check.output.passing == true", body: [check()] },
      { id: "after", type: "tool", tool: "read_file", input: { path: "p-${nodes.fix.output.check.passing}" }, dependsOn: ["fix"] },
    ]));
    const done = await execute(run.id, { inv });
    expect(done.status).toBe("passed");
    expect(inv.requests).toHaveLength(3);
    const cp = loopCp(done);
    expect(cp.status).toBe("passed");
    expect(cp.iterations!.map(it => it.status)).toEqual(["passed", "passed", "passed"]);
    expect(cp.iteration).toBe(2);
    expect(cp.output).toEqual({ check: { passing: true } });
    expect(done.nodes[1]!.status).toBe("passed");
    const events = await readEvents(store, run.id);
    expect(events.filter(e => e.type === "loop_iteration_started").map(e => (e as { iteration: number }).iteration)).toEqual([0, 1, 2]);
    expect(events.filter(e => e.type === "loop_iteration_completed")).toHaveLength(3);
  });

  it("stopWhen ends the loop on a body node status", async () => {
    const inv = mockInvoker('{"a":1}');
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 3, stopWhen: { node: "check", status: "passed" }, body: [check()] }]));
    const done = await execute(run.id, { inv });
    expect(done.status).toBe("passed");
    expect(loopCp(done).iterations).toHaveLength(1);
  });

  it("fails when exhausted, or passes with the last outputs under onExhausted: continue", async () => {
    const never = def([{ id: "fix", type: "loop", maxIterations: 4, until: "nodes.check.output.passing == true", body: [check()] }]);
    const failing = await execute((await create(never)).id, { inv: mockInvoker('{"passing":false}') });
    expect(failing.status).toBe("failed");
    expect(loopCp(failing).status).toBe("failed");
    expect(loopCp(failing).error).toBe("loop exhausted after 4 iterations");
    expect(loopCp(failing).iterations).toHaveLength(4);

    const cont = def([{ id: "fix", type: "loop", maxIterations: 4, onExhausted: "continue", until: "nodes.check.output.passing == true", body: [check()] }]);
    const passing = await execute((await create(cont)).id, { inv: mockInvoker('{"passing":false,"n":1}') });
    expect(passing.status).toBe("passed");
    expect(loopCp(passing).output).toEqual({ check: { passing: false, n: 1 } });
  });

  it("fails the loop when an iteration's body fails", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 3, body: [check()] }]));
    const done = await execute(run.id, { inv: mockInvoker("not json") });
    expect(done.status).toBe("failed");
    expect(loopCp(done).iterations).toHaveLength(1);
    expect(loopCp(done).error).toMatch(/^iteration 0 failed: check/);
  });

  it("passes loop.index and loop.prev into body task text", async () => {
    const inv = mockInvoker((req: AgentInvokeRequest) => `out-${req.task}`);
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 3, onExhausted: "continue", body: [
      { id: "a", type: "prompt", prompt: "i=${loop.index}" },
      { id: "b", type: "prompt", prompt: "prev=${loop.prev.a.output} n=${loop.history.0.index}", when: "loop.index > 0", dependsOn: ["a"] },
    ] }]));
    const done = await execute(run.id, { inv });
    expect(done.status).toBe("passed");
    expect(inv.requests.map(r => r.task)).toEqual(["i=0", "i=1", "prev=out-i=0 n=0", "i=2", "prev=out-i=1 n=0"]);
    expect(loopCp(done).iterations![0]!.nodes.b!.status).toBe("skipped");
  });

  it("resumes mid-iteration and only re-dispatches the interrupted body node", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 3, until: "nodes.b.output == 'done'", body: [
      { id: "a", type: "prompt", prompt: "A" },
      { id: "b", type: "prompt", prompt: "B", dependsOn: ["a"] },
    ] }]));
    const t = new Date().toISOString();
    const cp = loopCp(run);
    Object.assign(cp, { status: "running", startedAt: t, iteration: 1, iterations: [
      { index: 0, status: "passed", startedAt: t, endedAt: t, nodes: { a: { id: "a", status: "passed", output: "a0" }, b: { id: "b", status: "passed", output: "b0" } } },
      { index: 1, status: "running", startedAt: t, nodes: { a: { id: "a", status: "passed", output: "a1" }, b: { id: "b", status: "running", startedAt: t } } },
    ] });
    run.status = "running";
    await store.lock(run.id, () => store.save(run));
    const inv = mockInvoker("done");
    const done = await execute(run.id, { inv });
    expect(inv.requests.map(r => r.task)).toEqual(["B"]);
    expect(done.status).toBe("passed");
    const after = loopCp(done);
    expect(after.iterations).toHaveLength(2);
    expect(after.iterations![1]!.nodes.a!.output).toBe("a1");
    expect(after.output).toEqual({ a: "a1", b: "done" });
  });

  it("scopes body job requestIds per iteration", async () => {
    const coordinator = new FakeCoordinator();
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, onExhausted: "continue", body: [{ id: "build", type: "job", command: "make" }] }]));
    const done = await execute(run.id, { coordinator });
    expect(done.status).toBe("passed");
    const ids = coordinator.starts.map(s => s.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/build-1_i0$/);
    expect(ids[1]).toMatch(/build-1_i1$/);
    expect(loopCp(done).iterations![1]!.nodes.build!.job!.requestId).toBe(ids[1]);
  });

  it("a body node with when:false is skipped and the iteration still passes", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 1, until: "nodes.a.status == 'passed'", body: [
      { id: "a", type: "prompt", prompt: "A" },
      { id: "s", type: "tool", tool: "read_file", input: { path: "x" }, when: "loop.index < 0" },
    ] }]));
    const done = await execute(run.id, { inv: mockInvoker("ok") });
    expect(done.status).toBe("passed");
    const it0 = loopCp(done).iterations![0]!;
    expect(it0.status).toBe("passed");
    expect(it0.nodes.s!.status).toBe("skipped");
    expect(it0.nodes.s!.error).toMatch(/when is false/);
  });

  it("parks on an approval inside an iteration and continues the same iteration once approved", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, onExhausted: "continue", body: [
      { id: "ok", type: "approval", prompt: "go?" },
      { id: "a", type: "prompt", prompt: "A${loop.index}", dependsOn: ["ok"] },
    ] }]));
    const inv = mockInvoker("x");
    const parked = await execute(run.id, { inv });
    expect(parked.status).toBe("waiting_approval");
    expect(loopCp(parked).status).toBe("waiting_approval");
    expect(loopCp(parked).iterations![0]!.status).toBe("waiting_approval");
    const [first] = await listPendingDecisions(store, run.id);
    expect(first!.iteration).toEqual([0]);
    await decide(store, run.id, first!.decisionId, true, "tester");
    const next = await execute(run.id, { inv });
    // Iteration 1 asks again (decisions are keyed per iteration).
    expect(next.status).toBe("waiting_approval");
    expect(loopCp(next).iterations!.map(it => it.status)).toEqual(["passed", "waiting_approval"]);
    const pending = await listPendingDecisions(store, run.id);
    const second = pending.find(d => d.decisionId !== first!.decisionId)!;
    expect(second.iteration).toEqual([1]);
    await decide(store, run.id, second.decisionId, true, "tester");
    const done = await execute(run.id, { inv });
    expect(done.status).toBe("passed");
    expect(inv.requests.map(r => r.task)).toEqual(["A0", "A1"]);
  });

  it("denying an approval with a dependent in the loop body leaves a readable failed run", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, onExhausted: "continue", body: [
      { id: "gate", type: "approval", prompt: "go?" },
      { id: "a", type: "prompt", prompt: "A", dependsOn: ["gate"] },
    ] }]));
    const inv = mockInvoker("x");
    await execute(run.id, { inv });
    const [pending] = await listPendingDecisions(store, run.id);
    await decide(store, run.id, pending!.decisionId, false, "tester");
    const done = await execute(run.id, { inv });
    expect(done.status).toBe("failed");
    const read = await store.read(run.id, registry);
    expect(read.status).toBe("failed");
    const cp = loopCp(read);
    expect(cp.status).toBe("failed");
    expect(cp.iterations![0]!.nodes.gate!.status).toBe("failed");
    expect(cp.iterations![0]!.nodes.a!.status).toBe("pending");
    expect(inv.requests).toHaveLength(0);
    await expect(store.listIds()).resolves.toEqual([run.id]);
  });

  it("runs a job node in a loop body with a validator-faithful request id", async () => {
    const coordinator = new FakeCoordinator();
    const start = coordinator.start.bind(coordinator);
    coordinator.start = async request => { specPath("/x", request.requestId); return start(request); };
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, onExhausted: "continue", body: [{ id: "build", type: "job", command: "make" }] }]));
    const done = await execute(run.id, { coordinator });
    expect(done.status).toBe("passed");
    expect(coordinator.starts.map(s => s.requestId)).toEqual([jobRequestId(run.id, "build", 1, { loopPath: [{ loopId: "fix", iteration: 0 }] }), jobRequestId(run.id, "build", 1, { loopPath: [{ loopId: "fix", iteration: 1 }] })]);
    expect(coordinator.starts[0]!.requestId).toBe(`wf-${run.id}-build-1_i0`);
  });

  it("times out the loop and aborts its body", async () => {
    const inv = mockInvoker();
    inv.invoke = async req => { inv.requests.push(req); await new Promise(resolve => req.signal!.addEventListener("abort", resolve, { once: true })); return { text: "late", durationMs: 1 }; };
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 3, timeoutSeconds: 1, body: [check()] }]));
    const done = await execute(run.id, { inv });
    expect(done.status).toBe("timed_out");
    expect(loopCp(done).status).toBe("timed_out");
    expect(loopCp(done).error).toMatch(/Loop timed out after 1s/);
    expect(loopCp(done).iterations![0]!.status).toBe("timed_out");
  });

  it("cancelRun stops a running job inside a loop iteration and settles the loop", async () => {
    const coordinator = new FakeCoordinator();
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 3, body: [{ id: "build", type: "job", command: "make" }] }]));
    const scope = { loopPath: [{ loopId: "fix", iteration: 1 }] };
    const requestId = jobRequestId(run.id, "build", 1, scope);
    coordinator.jobs.set("job-7", summary(requestId, "job-7", "running"));
    coordinator.pollStates = ["running"];
    const t = new Date().toISOString();
    Object.assign(loopCp(run), { status: "running", startedAt: t, iteration: 1, iterations: [
      { index: 0, status: "passed", startedAt: t, endedAt: t, nodes: { build: { id: "build", status: "passed", job: { requestId: jobRequestId(run.id, "build", 1, { loopPath: [{ loopId: "fix", iteration: 0 }] }), jobId: "job-6" } } } },
      { index: 1, status: "running", startedAt: t, nodes: { build: { id: "build", status: "running", startedAt: t, job: { requestId, jobId: "job-7" } } } },
    ] });
    run.status = "running";
    await store.lock(run.id, () => store.save(run));
    const cancelled = await cancelRun(store, run.id, registry, undefined, jobDeps(coordinator));
    expect(coordinator.stops).toEqual(["job-7"]);
    expect(cancelled.status).toBe("cancelled");
    const cp = loopCp(cancelled);
    expect(cp.status).toBe("cancelled");
    expect(cp.iterations![1]).toMatchObject({ status: "cancelled", nodes: { build: { status: "cancelled" } } });
    await expect(store.read(run.id, registry)).resolves.toBeTruthy();
  });

  it("continueOnError: run tests, fix while failing, repeat until tests pass", async () => {
    const coordinator = new FakeCoordinator();
    // One poll per job: iterations 1-2 fail (exit 1), iteration 3 passes.
    coordinator.pollStates = ["failed", "failed", "completed"];
    const inv = mockInvoker("fixed");
    const run = await create(def([{ id: "loop", type: "loop", maxIterations: 5, until: "nodes.test.status == 'passed'", body: [
      { id: "test", type: "job", command: "npm test", continueOnError: true },
      { id: "fix", type: "prompt", prompt: "fix the failing tests (iteration ${loop.index})", dependsOn: ["test"], when: "nodes.test.status == 'failed'" },
    ] }]));
    const done = await execute(run.id, { inv, coordinator });
    expect(done.status).toBe("passed");
    const cp = loopCp(done, "loop");
    expect(cp.status).toBe("passed");
    expect(cp.iterations).toHaveLength(3);
    expect(cp.iterations!.map(it => it.status)).toEqual(["passed", "passed", "passed"]);
    expect(cp.iterations!.map(it => it.nodes.test!.status)).toEqual(["failed", "failed", "passed"]);
    expect(cp.iterations!.map(it => it.nodes.fix!.status)).toEqual(["passed", "passed", "skipped"]);
    expect(coordinator.starts).toHaveLength(3);
    expect(inv.requests.map(r => r.task)).toEqual(["fix the failing tests (iteration 0)", "fix the failing tests (iteration 1)"]);
  });

  it("continueOnError: stopWhen can match a failed status; without it the failure fails the loop", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = ["failed"];
    const stop = await create(def([{ id: "loop", type: "loop", maxIterations: 3, stopWhen: { node: "test", status: "failed" }, body: [{ id: "test", type: "job", command: "npm test", continueOnError: true }] }]));
    const stopped = await execute(stop.id, { coordinator });
    expect(stopped.status).toBe("passed");
    expect(loopCp(stopped, "loop").iterations).toHaveLength(1);

    const strict = await create(def([{ id: "loop", type: "loop", maxIterations: 3, until: "nodes.test.status == 'passed'", body: [{ id: "test", type: "job", command: "npm test" }] }]));
    const failed = await execute(strict.id, { coordinator: Object.assign(new FakeCoordinator(), { pollStates: ["failed"] }) });
    expect(failed.status).toBe("failed");
    expect(loopCp(failed, "loop").error).toMatch(/^iteration 0 failed: test/);
  });

  it("continueOnError does not tolerate an uncertain outcome", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = ["unknown"];
    const run = await create(def([{ id: "loop", type: "loop", maxIterations: 3, onExhausted: "continue", body: [{ id: "test", type: "job", command: "npm test", continueOnError: true }] }]));
    const done = await execute(run.id, { coordinator });
    expect(done.status).toBe("failed");
    expect(loopCp(done, "loop").iterations![0]!.nodes.test!.error).toMatch(/^uncertain/);
  });

  it("spills large body outputs to scoped artifacts and caps loop.history", async () => {
    const big = "x".repeat(MAX_INLINE_OUTPUT_BYTES + 1000);
    const inv = mockInvoker((req: AgentInvokeRequest) => req.task.startsWith("make") ? big : `len=${req.task.length}`);
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, onExhausted: "continue", body: [
      { id: "big", type: "prompt", prompt: "make big" },
      { id: "use", type: "prompt", prompt: "prev ${loop.history.0.outputs.big}", when: "loop.index > 0", dependsOn: ["big"] },
    ] }]));
    const done = await execute(run.id, { inv });
    expect(done.status).toBe("passed");
    // In memory the run keeps full values.
    expect(loopCp(done).iterations![0]!.nodes.big!.output).toBe(big);
    const raw = JSON.parse(await readFile(join(store.root, `${run.id}.json`), "utf8")) as WorkflowRun;
    const persisted = raw.nodes[0] as LoopNodeCheckpoint;
    expect(persisted.iterations![0]!.nodes.big!.output).toEqual({ $artifact: "artifacts/fix.0.big.json", bytes: big.length + 2 });
    expect(persisted.iterations![1]!.nodes.big!.output).toEqual({ $artifact: "artifacts/fix.1.big.json", bytes: big.length + 2 });
    expect(JSON.parse(await readFile(join(store.runDir(run.id), "artifacts/fix.1.big.json"), "utf8"))).toBe(big);
    expect(Buffer.byteLength(await readFile(join(store.root, `${run.id}.json`), "utf8"))).toBeLessThan(MAX_INLINE_OUTPUT_BYTES);
    // loop.history outputs are capped (a truncated summary), not the full value.
    const useTask = inv.requests.find(r => r.task.startsWith("prev "))!.task;
    expect(useTask.length).toBeLessThan(MAX_INLINE_OUTPUT_BYTES + 200);
    expect(useTask).toMatch(/… \(truncated; \d+ bytes\)$/);
    // The scoped references validate and hydrate again on read.
    const read = await store.read(run.id, registry);
    await store.hydrateOutputs(read);
    expect((read.nodes[0] as LoopNodeCheckpoint).iterations![0]!.nodes.big!.output).toBe(big);
  });

  it("cancelRun settles an approval parked inside a loop iteration and the loop to cancelled", async () => {
    const run = await create(def([{ id: "fix", type: "loop", maxIterations: 2, onExhausted: "continue", body: [
      { id: "ok", type: "approval", prompt: "go?" },
      { id: "a", type: "prompt", prompt: "A", dependsOn: ["ok"] },
    ] }]));
    const parked = await execute(run.id, { inv: mockInvoker("x") });
    expect(parked.status).toBe("waiting_approval");
    const cancelled = await cancelRun(store, run.id, registry);
    expect(cancelled.status).toBe("cancelled");
    const cp = loopCp(cancelled);
    expect(cp.status).toBe("cancelled");
    expect(cp.iterations![0]!.status).toBe("cancelled");
    expect(cp.iterations![0]!.nodes.ok!.status).toBe("cancelled");
    expect(cp.iterations![0]!.nodes.a!.status).toBe("pending");
    const read = await store.read(run.id, registry);
    expect((read.nodes[0] as LoopNodeCheckpoint).iterations![0]!.nodes.ok!.status).toBe("cancelled");
  });
});
