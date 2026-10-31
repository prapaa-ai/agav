import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideApproval } from "../workflows/control.js";
import { getNodeExecutor } from "../workflows/executors.js";
import { createRun, executeRun, MAX_EXECUTIONS } from "../workflows/runtime.js";
import { jobRequestId, MAX_INLINE_OUTPUT_BYTES, WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, jobDeps, registry, summary, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const runPath = (id: string) => join(store.root, `${id}.json`);
async function rawRun(id: string): Promise<WorkflowRun> { return JSON.parse(await readFile(runPath(id), "utf8")) as WorkflowRun; }
async function writeRaw(run: WorkflowRun): Promise<void> { await writeFile(runPath(run.id), JSON.stringify(run)); }
const config = testConfig();

describe("NodeExecutor registry", () => {
  it("registers tool, approval, job, agent, prompt and loop; only job is resumable", () => {
    expect(getNodeExecutor("tool").type).toBe("tool");
    expect(getNodeExecutor("approval").type).toBe("approval");
    expect(getNodeExecutor("job").resumable).toBe(true);
    expect(getNodeExecutor("tool").resumable).toBeUndefined();
    expect(getNodeExecutor("agent").resumable).toBeUndefined();
    expect(getNodeExecutor("prompt").type).toBe("prompt");
    expect(getNodeExecutor("loop").type).toBe("loop");
    expect(() => getNodeExecutor("bogus")).toThrow(/No executor/);
  });
});

describe("executeRun", () => {
  it("runs tool nodes in dependency order and interpolates inputs and outputs", async () => {
    const host = fakeHost({ read_file: { output: "hello", isError: false } });
    const d = def([
      { id: "w", type: "tool", tool: "write_file", input: { path: "o.txt", content: "${inputs.x}:${nodes.r.output}" }, dependsOn: ["r"] },
      { id: "r", type: "tool", tool: "read_file", input: { path: "i.txt" } },
    ]);
    const run = await createRun(store, d, { x: "in" });
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("passed");
    expect(host.calls.map(c => c.name)).toEqual(["read_file", "write_file"]);
    expect(host.calls[1]!.input).toEqual({ path: "o.txt", content: "in:hello" });
    expect((await store.read(run.id, registry)).nodes.map(n => n.status)).toEqual(["passed", "passed"]);
  });

  it("fails the run once the execution cap is exceeded, without dispatching further nodes", async () => {
    const host = fakeHost({ read_file: { output: "hello", isError: false } });
    const d = def([
      { id: "a", type: "tool", tool: "read_file", input: { path: "a" } },
      { id: "b", type: "tool", tool: "read_file", input: { path: "b" }, dependsOn: ["a"] },
    ]);
    const run = await createRun(store, d, {});
    const raw = await rawRun(run.id);
    raw.executionCount = MAX_EXECUTIONS - 1;
    await writeRaw(raw);
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("failed");
    expect(host.calls).toHaveLength(1);
    expect(done.executionCount).toBe(MAX_EXECUTIONS);
    expect(done.nodes.map(n => n.status)).toEqual(["passed", "failed"]);
    expect(done.nodes[1]!.error).toBe(`execution cap (${MAX_EXECUTIONS}) exceeded`);
  });

  it("stops at the first failed node", async () => {
    const host = fakeHost({ read_file: { output: "boom", isError: true } });
    const d = def([{ id: "r", type: "tool", tool: "read_file", input: { path: "i" } }, { id: "n", type: "tool", tool: "list_directory", input: { path: "." }, dependsOn: ["r"] }]);
    const run = await createRun(store, d, {});
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("failed");
    expect(done.nodes.map(n => n.status)).toEqual(["failed", "pending"]);
    expect(done.nodes[0]!.error).toBe("boom");
    expect(host.calls).toHaveLength(1);
  });

  it("fails headless mutating tools that need confirmation, without executing them", async () => {
    const run = await createRun(store, def([{ id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "c" } }]), {});
    const done = await executeRun(store, run.id, registry, testConfig({ permissionMode: "ask" }));
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/headless/);
  });

  it("refuses an unresolved reference", async () => {
    const host = fakeHost();
    const run = await createRun(store, def([{ id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "${inputs.missing}" } }]), {});
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/Unresolved workflow reference/);
    expect(host.calls).toHaveLength(0);
  });

  it("parks at an approval, then resumes after approve", async () => {
    const host = fakeHost();
    const d = def([
      { id: "a", type: "tool", tool: "list_directory", input: { path: "." } },
      { id: "gate", type: "approval", prompt: "go?", dependsOn: ["a"] },
      { id: "b", type: "tool", tool: "list_directory", input: { path: "." }, dependsOn: ["gate"] },
    ]);
    const run = await createRun(store, d, {});
    const parked = await executeRun(store, run.id, registry, config, undefined, host);
    expect(parked.status).toBe("waiting_approval");
    expect(parked.nodes.map(n => n.status)).toEqual(["passed", "waiting_approval", "pending"]);
    // Resuming without a decision changes nothing.
    expect((await executeRun(store, run.id, registry, config, undefined, host)).status).toBe("waiting_approval");
    await decideApproval(store, run.id, "gate", true, { registry, by: "tester@host" });
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("passed");
    expect(done.nodes[1]!).toMatchObject({ output: "approved", decision: { decision: "approve", decidedBy: "tester@host" } });
    expect(host.calls).toHaveLength(2);
  });

  it("parks an interrupted mutating tool node on an uncertain_tool decision instead of replaying it", async () => {
    const host = fakeHost();
    const run = await createRun(store, def([{ id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "c" } }]), {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "w", status: "running", startedAt: new Date().toISOString() };
    await writeRaw(raw);
    const parked = await executeRun(store, run.id, registry, config, undefined, host);
    expect(parked.status).toBe("waiting_approval");
    expect(host.calls).toHaveLength(0);
    expect((await store.read(run.id, registry)).nodes[0]).toMatchObject({ status: "waiting_approval", decisionId: expect.stringMatching(/^dec_/) });
  });

  it("settles a crash snapshot with a failed node to a failed run without dispatching", async () => {
    const host = fakeHost();
    const d = def([{ id: "a", type: "tool", tool: "list_directory", input: { path: "." } }, { id: "b", type: "tool", tool: "list_directory", input: { path: "." } }]);
    const run = await createRun(store, d, {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0]!.status = "failed";
    await writeRaw(raw);
    expect((await executeRun(store, run.id, registry, config, undefined, host)).status).toBe("failed");
    expect(host.calls).toHaveLength(0);
  });

  it("returns terminal runs unchanged", async () => {
    const host = fakeHost();
    const run = await createRun(store, def([{ id: "a", type: "tool", tool: "list_directory", input: { path: "." } }]), {});
    await executeRun(store, run.id, registry, config, undefined, host);
    await executeRun(store, run.id, registry, config, undefined, host);
    expect(host.calls).toHaveLength(1);
  });

  it("cancels before dispatch when a cancel marker exists", async () => {
    const host = fakeHost();
    const run = await createRun(store, def([{ id: "a", type: "tool", tool: "list_directory", input: { path: "." } }]), {});
    await store.requestCancel(run.id);
    expect((await executeRun(store, run.id, registry, config, undefined, host)).status).toBe("cancelled");
    expect(host.calls).toHaveLength(0);
  });

  it("refuses to resume from a different working directory", async () => {
    const run = await createRun(store, def([{ id: "a", type: "tool", tool: "list_directory", input: { path: "." } }]), {});
    const raw = await rawRun(run.id);
    raw.cwd = "/definitely/not/here";
    await writeRaw(raw);
    await expect(executeRun(store, run.id, registry, config, undefined, fakeHost())).rejects.toThrow(/original working directory/);
  });

  it("spills a large tool output to an artifact and interpolates the real value after resume", async () => {
    const big = "z".repeat(MAX_INLINE_OUTPUT_BYTES + 100);
    const host = fakeHost({ read_file: { output: big, isError: false } });
    const d = def([
      { id: "r", type: "tool", tool: "read_file", input: { path: "big" } },
      { id: "gate", type: "approval", prompt: "go?", dependsOn: ["r"] },
      { id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "${nodes.r.output}" }, dependsOn: ["gate"] },
    ]);
    const run = await createRun(store, d, {});
    await executeRun(store, run.id, registry, config, undefined, host);
    expect((await rawRun(run.id)).nodes[0]!.output).toMatchObject({ $artifact: "artifacts/r.json" });
    await decideApproval(store, run.id, "gate", true, { registry });
    const done = await executeRun(store, run.id, registry, config, undefined, host);
    expect(done.status).toBe("passed");
    expect(host.calls[1]!.input.content).toBe(big);
  });
});

describe("job nodes", () => {
  const jobDef = def([{ id: "j", type: "job", command: "echo hi" }, { id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "GOT:${nodes.j.output}" }, dependsOn: ["j"] }]);

  it("starts once with the attempt-1 requestId and passes stdout downstream", async () => {
    const coordinator = new FakeCoordinator();
    const host = fakeHost();
    const run = await createRun(store, jobDef, {});
    const done = await executeRun(store, run.id, registry, config, undefined, host, jobDeps(coordinator));
    expect(done.status).toBe("passed");
    expect(coordinator.starts).toHaveLength(1);
    expect(coordinator.starts[0]!.requestId).toBe(jobRequestId(run.id, "j"));
    expect(coordinator.starts[0]!.cwd).toBe(run.cwd);
    expect(done.nodes[0]!.job).toMatchObject({ requestId: `wf-${run.id}-j-1`, jobId: "job-1", state: "completed", exitCode: 0 });
    expect(host.calls[0]!.input.content).toBe("GOT:job-output");
  });

  it("fails without launching when no job support is supplied", async () => {
    const run = await createRun(store, jobDef, {});
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost());
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/no job was launched/);
  });

  it("refuses a fresh start when sandboxRequired is set", async () => {
    const coordinator = new FakeCoordinator();
    const run = await createRun(store, jobDef, {});
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator, { sandboxRequired: true }));
    expect(done.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
  });

  it.each([1, 3])("reattaches a running job (attempt %i) without a second start", async attempt => {
    const coordinator = new FakeCoordinator();
    const run = await createRun(store, jobDef, {});
    const requestId = jobRequestId(run.id, "j", attempt);
    coordinator.jobs.set("job-9", summary(requestId, "job-9", "running"));
    coordinator.pollStates = ["running", "completed"];
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "j", status: "running", startedAt: new Date().toISOString(), job: { requestId, jobId: "job-9", state: "running" } };
    await writeRaw(raw);
    const host = fakeHost();
    const done = await executeRun(store, run.id, registry, config, undefined, host, jobDeps(coordinator));
    expect(coordinator.starts).toHaveLength(0);
    expect(done.status).toBe("passed");
    expect(done.nodes[0]!.job).toMatchObject({ requestId, jobId: "job-9", state: "completed" });
    expect(host.calls).toHaveLength(1);
  });

  it("reattaches by requestId when the jobId was never persisted", async () => {
    const coordinator = new FakeCoordinator();
    const run = await createRun(store, jobDef, {});
    coordinator.jobs.set("job-7", summary(jobRequestId(run.id, "j"), "job-7", "running"));
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "j", status: "running", job: { requestId: jobRequestId(run.id, "j") } };
    await writeRaw(raw);
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(coordinator.starts).toHaveLength(0);
    expect(done.nodes[0]!.job!.jobId).toBe("job-7");
  });

  it("fails closed (no start) when a resumed job cannot be found", async () => {
    const coordinator = new FakeCoordinator();
    const run = await createRun(store, jobDef, {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "j", status: "running", job: { requestId: jobRequestId(run.id, "j") } };
    await writeRaw(raw);
    const done = await executeRun(store, run.id, registry, config, undefined, fakeHost(), jobDeps(coordinator));
    expect(coordinator.starts).toHaveLength(0);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/refusing to start a second workload/);
  });

  it("keeps a running job checkpoint when resumed without job support", async () => {
    const run = await createRun(store, jobDef, {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "j", status: "running", job: { requestId: jobRequestId(run.id, "j"), jobId: "job-1" } };
    await writeRaw(raw);
    await expect(executeRun(store, run.id, registry, config, undefined, fakeHost())).rejects.toThrow(/resume with background-job support to reattach/);
    expect((await store.read(run.id, registry)).nodes[0]!.status).toBe("running");
  });
});
