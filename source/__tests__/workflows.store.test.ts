import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRun } from "../workflows/runtime.js";
import { jobRequestId, jobAttempt, MAX_INLINE_OUTPUT_BYTES, WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, registry, tempStore } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const runPath = (id: string) => join(store.root, `${id}.json`);
async function rawRun(id: string): Promise<WorkflowRun> { return JSON.parse(await readFile(runPath(id), "utf8")) as WorkflowRun; }
async function writeRaw(run: WorkflowRun): Promise<void> { await writeFile(runPath(run.id), JSON.stringify(run)); }

const jobDef = def([{ id: "j", type: "job", command: "echo hi" }]);
const toolDef = def([{ id: "a", type: "tool", tool: "list_directory", input: { path: "." } }, { id: "b", type: "tool", tool: "list_directory", input: { path: "." }, dependsOn: ["a"] }]);

describe("jobRequestId", () => {
  it("defaults to attempt 1 and encodes any positive attempt", () => {
    expect(jobRequestId("r", "n")).toBe("wf-r-n-1");
    expect(jobRequestId("r", "n", 3)).toBe("wf-r-n-3");
    expect(() => jobRequestId("r", "n", 0)).toThrow();
    expect(() => jobRequestId("r", "n", 1.5)).toThrow();
  });
  it("parses attempts and rejects foreign ids", () => {
    expect(jobAttempt("wf-r-n-12", "r", "n")).toBe(12);
    expect(jobAttempt("wf-r-n-0", "r", "n")).toBeUndefined();
    expect(jobAttempt("wf-r-n-01", "r", "n")).toBeUndefined();
    expect(jobAttempt("wf-r-other-1", "r", "n")).toBeUndefined();
    expect(jobAttempt("wf-r-n-1x", "r", "n")).toBeUndefined();
  });
});

describe("WorkflowStore.read", () => {
  it("round-trips a fresh run with host", async () => {
    const run = await createRun(store, toolDef, {}, { host: "foreground" });
    const read = await store.read(run.id, registry);
    expect(read.status).toBe("pending");
    expect(read.host).toBe("foreground");
  });

  it("reads old checkpoints with a `-1` job attempt and accepts later attempts", async () => {
    const run = await createRun(store, jobDef, {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[0] = { id: "j", status: "running", job: { requestId: `wf-${run.id}-j-1`, jobId: "job-1", state: "running" } };
    await writeRaw(raw);
    expect((await store.read(run.id, registry)).nodes[0]!.job!.requestId).toBe(`wf-${run.id}-j-1`);
    raw.nodes[0]!.job!.requestId = jobRequestId(run.id, "j", 4);
    await writeRaw(raw);
    expect((await store.read(run.id, registry)).nodes[0]!.job!.requestId).toBe(`wf-${run.id}-j-4`);
  });

  it.each([
    ["foreign job requestId", (r: WorkflowRun) => { r.status = "running"; r.nodes[0] = { id: "j", status: "running", job: { requestId: "wf-other-j-1" } }; }],
    ["attempt 0", (r: WorkflowRun) => { r.status = "running"; r.nodes[0] = { id: "j", status: "running", job: { requestId: `wf-${r.id}-j-0` } }; }],
    ["running job without identity", (r: WorkflowRun) => { r.status = "running"; r.nodes[0] = { id: "j", status: "running" }; }],
    ["extra job metadata", (r: WorkflowRun) => { r.status = "running"; r.nodes[0] = { id: "j", status: "running", job: { requestId: `wf-${r.id}-j-1`, extra: 1 } as never }; }],
    ["unknown node status", (r: WorkflowRun) => { r.nodes[0]!.status = "bogus" as never; }],
    ["unknown run status", (r: WorkflowRun) => { r.status = "bogus" as never; }],
    ["node-only status on run", (r: WorkflowRun) => { r.status = "skipped" as never; }],
    ["invalid host", (r: WorkflowRun) => { r.host = "daemon" as never; }],
    ["tampered definition", (r: WorkflowRun) => { r.definition.name = "changed"; }],
    ["wrong node count", (r: WorkflowRun) => { r.nodes = []; }],
    ["forged artifact reference", (r: WorkflowRun) => { r.status = "running"; r.nodes[0] = { id: "j", status: "failed", output: { $artifact: "../../etc/passwd", bytes: 10 } }; }],
  ])("refuses a corrupt checkpoint: %s", async (_label, mutate) => {
    const run = await createRun(store, jobDef, {});
    const raw = await rawRun(run.id);
    mutate(raw);
    await writeRaw(raw);
    await expect(store.read(run.id, registry)).rejects.toThrow(/workflow checkpoint/i);
  });

  it("refuses unparsable checkpoints instead of treating them as fresh", async () => {
    const run = await createRun(store, jobDef, {});
    await writeFile(runPath(run.id), "{ truncated");
    await expect(store.read(run.id, registry)).rejects.toThrow();
  });

  it("refuses a node dispatched past an unpassed dependency", async () => {
    const run = await createRun(store, toolDef, {});
    const raw = await rawRun(run.id);
    raw.status = "running"; raw.nodes[1]!.status = "passed";
    await writeRaw(raw);
    await expect(store.read(run.id, registry)).rejects.toThrow(/invalid node state or dependencies/);
  });

  it("accepts skipped nodes and counts them as settled for a passed run", async () => {
    const run = await createRun(store, toolDef, {});
    const raw = await rawRun(run.id);
    raw.status = "passed"; raw.nodes[0]!.status = "skipped"; raw.nodes[1]!.status = "skipped";
    await writeRaw(raw);
    expect((await store.read(run.id, registry)).nodes.map(n => n.status)).toEqual(["skipped", "skipped"]);
    raw.nodes[0]!.status = "pending";
    await writeRaw(raw);
    await expect(store.read(run.id, registry)).rejects.toThrow(/Corrupt/);
  });

  it("accepts every RunStatus", async () => {
    const run = await createRun(store, toolDef, {});
    const raw = await rawRun(run.id);
    raw.nodes[0]!.status = "passed";
    for (const status of ["queued", "running", "failed", "timed_out", "waiting_approval", "cancelling", "cancelled", "interrupted"] as const) {
      raw.status = status;
      await writeRaw(raw);
      expect((await store.read(run.id, registry)).status).toBe(status);
    }
  });
});

describe("output storage", () => {
  it("keeps structured outputs inline under the cap", async () => {
    const run = await createRun(store, toolDef, {});
    run.status = "running"; run.nodes[0]!.status = "passed"; run.nodes[0]!.output = { a: [1, 2], b: "x" };
    await store.save(run);
    expect((await store.read(run.id, registry)).nodes[0]!.output).toEqual({ a: [1, 2], b: "x" });
  });

  it("spills oversized outputs to an artifact and hydrates them back", async () => {
    const run = await createRun(store, toolDef, {});
    const big = "x".repeat(MAX_INLINE_OUTPUT_BYTES + 10);
    run.status = "running"; run.nodes[0]!.status = "passed"; run.nodes[0]!.output = big;
    await store.save(run);
    expect(run.nodes[0]!.output).toBe(big); // in-memory value untouched
    const bytes = Buffer.byteLength(JSON.stringify(big));
    expect((await rawRun(run.id)).nodes[0]!.output).toEqual({ $artifact: "artifacts/a.json", bytes });
    expect((await stat(join(store.runDir(run.id), "artifacts", "a.json"))).size).toBe(bytes);
    const read = await store.read(run.id, registry);
    expect(read.nodes[0]!.output).toEqual({ $artifact: "artifacts/a.json", bytes });
    expect(await store.readOutput(run.id, read.nodes[0]!)).toBe(big);
    await store.hydrateOutputs(read);
    expect(read.nodes[0]!.output).toBe(big);
    // Re-saving a read (unhydrated) run keeps the reference intact.
    await store.save(await store.read(run.id, registry));
    expect((await rawRun(run.id)).nodes[0]!.output).toEqual({ $artifact: "artifacts/a.json", bytes });
  });

  it("never persists a node-produced value that only looks like a reference", async () => {
    const run = await createRun(store, toolDef, {});
    run.status = "running"; run.nodes[0]!.status = "passed"; run.nodes[0]!.output = { $artifact: "elsewhere", bytes: 1 };
    await store.save(run);
    const read = await store.read(run.id, registry);
    expect(await store.readOutput(run.id, read.nodes[0]!)).toEqual({ $artifact: "elsewhere", bytes: 1 });
  });

  it("detects a tampered artifact", async () => {
    const run = await createRun(store, toolDef, {});
    run.status = "running"; run.nodes[0]!.status = "passed"; run.nodes[0]!.output = "y".repeat(MAX_INLINE_OUTPUT_BYTES + 1);
    await store.save(run);
    await writeFile(join(store.runDir(run.id), "artifacts", "a.json"), "\"short\"");
    const read = await store.read(run.id, registry);
    await expect(store.readOutput(run.id, read.nodes[0]!)).rejects.toThrow(/size mismatch/);
  });
});
