import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cancelRun, decideApproval } from "../workflows/control.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { jobRequestId, WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, jobDeps, registry, summary, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const runPath = (id: string) => join(store.root, `${id}.json`);
async function rawRun(id: string): Promise<WorkflowRun> { return JSON.parse(await readFile(runPath(id), "utf8")) as WorkflowRun; }
async function writeRaw(run: WorkflowRun): Promise<void> { await writeFile(runPath(run.id), JSON.stringify(run)); }
const config = testConfig();
const gated = def([{ id: "gate", type: "approval", prompt: "go?" }, { id: "b", type: "tool", tool: "list_directory", input: { path: "." }, dependsOn: ["gate"] }]);

describe("decideApproval", () => {
  it("writes only the decision file (never run.json); the resumed run applies approve as passed", async () => {
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, config, undefined, fakeHost());
    const before = await readFile(runPath(run.id), "utf8");
    const decided = await decideApproval(store, run.id, "gate", true, { registry, by: "a@h", note: "lgtm" });
    expect(decided).toMatchObject({ won: true, record: { decision: "approve", decidedBy: "a@h", note: "lgtm" } });
    expect(await readFile(runPath(run.id), "utf8")).toBe(before);
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost());
    expect(done.status).toBe("passed");
    expect(done.nodes[0]).toMatchObject({ status: "passed", output: "approved", decision: { decision: "approve", note: "lgtm" } });
  });

  it("deny fails the run on resume without dispatching", async () => {
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, config, undefined, fakeHost());
    await decideApproval(store, run.id, "gate", false, { registry, by: "a@h" });
    const host = fakeHost();
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]).toMatchObject({ status: "failed", output: "denied", error: expect.stringMatching(/Approval denied by a@h/) });
    expect(host.calls).toHaveLength(0);
  });

  it("rejects targets without a pending approval and reports an already-made decision", async () => {
    const run = await createRun(store, gated, {});
    await expect(decideApproval(store, run.id, "gate", true, { registry })).rejects.toThrow(/no pending approval decision/);
    await executeRun(store, run.id, registry, config, undefined, fakeHost());
    await expect(decideApproval(store, run.id, "b", true, { registry })).rejects.toThrow(/no pending approval decision/);
    const first = await decideApproval(store, run.id, "gate", true, { registry });
    expect(first.won).toBe(true);
    // By decision id: the second decider loses and sees the winning record.
    const second = await decideApproval(store, run.id, first.pending.decisionId, false, { registry });
    expect(second).toMatchObject({ won: false, record: { decision: "approve" } });
  });
});

describe("cancelRun", () => {
  it("cancels a parked run and leaves terminal runs untouched", async () => {
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, config, undefined, fakeHost());
    expect((await cancelRun(store, run.id, registry)).status).toBe("cancelled");
    expect(await store.cancellationRequested(run.id)).toBe(true);
    expect((await cancelRun(store, run.id, registry)).status).toBe("cancelled");
    const host = fakeHost();
    expect((await executeRun(store, run.id, registry, config, undefined, host)).status).toBe("cancelled");
    expect(host.calls).toHaveLength(0);
  });

  it("refuses to claim an interrupted tool node stopped", async () => {
    const run = await createRun(store, def([{ id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "c" } }]), {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0]!.status = "running";
    await writeRaw(raw);
    await expect(cancelRun(store, run.id, registry)).rejects.toThrow(/uncertain outcome/);
    expect((await store.read(run.id, registry)).status).toBe("running");
  });

  it("stops a running job node from a checkpoint (recorded attempt id) and marks the run cancelled", async () => {
    const coordinator = new FakeCoordinator();
    const run = await createRun(store, def([{ id: "j", type: "job", command: "sleep 100" }]), {});
    const requestId = jobRequestId(run.id, "j", 2);
    coordinator.jobs.set("job-5", summary(requestId, "job-5", "running"));
    coordinator.pollStates = ["running"];
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "j", status: "running", job: { requestId, jobId: "job-5" } };
    await writeRaw(raw);
    const cancelled = await cancelRun(store, run.id, registry, undefined, jobDeps(coordinator));
    expect(coordinator.stops).toEqual(["job-5"]);
    expect(coordinator.starts).toHaveLength(0);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nodes[0]).toMatchObject({ status: "cancelled", job: { requestId, state: "interrupted" } });
  });

  it("keeps the run recoverable when a running job cannot be stopped without job support", async () => {
    const run = await createRun(store, def([{ id: "j", type: "job", command: "sleep 100" }]), {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "j", status: "running", job: { requestId: jobRequestId(run.id, "j"), jobId: "job-1" } };
    await writeRaw(raw);
    await expect(cancelRun(store, run.id, registry)).rejects.toThrow(/no background-job support/);
    expect((await store.read(run.id, registry)).nodes[0]!.status).toBe("running");
  });

  it("cancels a live execution: the executor stops its job and cancelRun waits for the lock", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = ["running"];
    const deps = jobDeps(coordinator);
    const run = await createRun(store, def([{ id: "j", type: "job", command: "sleep 100" }]), {});
    const executing = executeRun(store, run.id, registry, config, undefined, fakeHost(), deps);
    for (let i = 0; i < 200 && coordinator.starts.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(coordinator.starts).toHaveLength(1);
    const cancelled = await cancelRun(store, run.id, registry, undefined, deps);
    const executed = await executing;
    expect(executed.status).toBe("cancelled");
    expect(cancelled.status).toBe("cancelled");
    expect(coordinator.stops).toEqual(["job-1"]);
    expect(cancelled.nodes[0]!.status).toBe("cancelled");
  });
});
