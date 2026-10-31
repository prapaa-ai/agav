import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDefinition, validateDefinition, walkNodes, type WorkflowDefinition } from "../workflows/definition.js";
import { createRun } from "../workflows/runtime.js";
import { specPath } from "../background-jobs/storage/paths.js";
import { jobAttempt, jobRequestId, WorkflowStore, type LoopNodeCheckpoint, type WorkflowRun } from "../workflows/store.js";
import { getNodeExecutor } from "../workflows/executors.js";
import { registry, tempStore } from "./helpers/workflow-fixtures.js";

const base = (nodes: unknown[]) => ({ version: 1, name: "x", nodes });
const tool = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "tool", tool: "list_directory", input: { path: "." }, ...extra });
const loop = (id: string, body: unknown[], extra: Record<string, unknown> = {}) => ({ id, type: "loop", maxIterations: 3, body, ...extra });

describe("loop definitions", () => {
  it("accepts a valid loop and walks nested nodes", () => {
    const d = validateDefinition(base([
      tool("prep"),
      loop("fix", [
        tool("check", { input: { path: "${nodes.prep.output}" } }),
        tool("edit", { dependsOn: ["check"], input: { path: "${loop.index}-${nodes.check.output}" }, when: "loop.index < 2" }),
      ], { dependsOn: ["prep"], until: "nodes.edit.status == 'passed' && loop.index >= 0", stopWhen: { node: "check", status: "failed" }, onExhausted: "continue", historyLimit: 5, timeoutSeconds: 60 }),
      tool("after", { dependsOn: ["fix"], input: { path: "${nodes.fix.output.x}" } }),
    ]), registry);
    const seen: string[] = [];
    walkNodes(d, (node, path) => seen.push([...path, node.id].join("/")));
    expect(seen).toEqual(["prep", "fix", "fix/check", "fix/edit", "after"]);
  });

  it("accepts a loop nested in a loop", () => {
    expect(() => validateDefinition(base([loop("outer", [loop("inner", [tool("t")])])]), registry)).not.toThrow();
  });

  it.each([
    ["maxIterations missing", base([{ id: "l", type: "loop", body: [tool("t")] }]), /maxIterations/],
    ["maxIterations 0", base([loop("l", [tool("t")], { maxIterations: 0 })]), /Invalid workflow/],
    ["maxIterations 51", base([loop("l", [tool("t")], { maxIterations: 51 })]), /maxIterations/],
    ["empty body", base([loop("l", [])]), /Invalid workflow/],
    ["depth 3", base([loop("a", [loop("b", [loop("c", [tool("t")])])])]), /nested at most 2/],
    ["body dependsOn outside", base([tool("out"), loop("l", [tool("t", { dependsOn: ["out"] })], { dependsOn: ["out"] })]), /outside the body/],
    ["body cycle", base([loop("l", [tool("a", { dependsOn: ["b"] }), tool("b", { dependsOn: ["a"] })])]), /Dependency cycle/],
    ["duplicate id across scopes", base([tool("t"), loop("l", [tool("t")])]), /Duplicate node: t/],
    ["unknown body ref", base([loop("l", [tool("t", { input: { path: "${nodes.ghost.output}" } })])]), /unknown node "ghost"/],
    ["body ref to outer node the loop does not depend on", base([tool("o"), loop("l", [tool("t", { input: { path: "${nodes.o.output}" } })])]), /not one of its dependencies/],
    ["body ref to non-dependency sibling", base([loop("l", [tool("a"), tool("b", { input: { path: "${nodes.a.output}" } })])]), /not one of its dependencies/],
    ["loop.index outside a loop", base([tool("t", { input: { path: "${loop.index}" } })]), /loop\.\* outside a loop/],
    ["loop.index in a top-level when", base([tool("t", { when: "loop.index == 1" })]), /loop\.\* outside a loop/],
    ["invalid until", base([loop("l", [tool("t")], { until: "nodes.t.status ==" })]), /invalid until/],
    ["until referencing a non-body node", base([tool("o"), loop("l", [tool("t")], { until: "nodes.o.status == 'passed'" })]), /neither a body node/],
    ["stopWhen unknown node", base([loop("l", [tool("t")], { stopWhen: { node: "nope", status: "passed" } })]), /unknown node "nope"/],
    ["stopWhen bad status", base([loop("l", [tool("t")], { stopWhen: { node: "t", status: "done" } })]), /Invalid workflow/],
    ["retry on a loop", base([loop("l", [tool("t")], { retry: { max: 1 } })]), /do not support retry/],
    ["outside ref to loop without dependency", base([loop("l", [tool("t")]), tool("after", { input: { path: "${nodes.l.output}" } })]), /not one of its dependencies/],
    ["outside ref into a loop body", base([loop("l", [tool("t")]), tool("after", { dependsOn: ["l"], input: { path: "${nodes.t.output}" } })]), /not one of its dependencies/],
    ["body on a non-loop node", base([tool("t", { body: [tool("u")] })]), /only allowed on loop nodes/],
    ["historyLimit 21", base([loop("l", [tool("t")], { historyLimit: 21 })]), /Invalid workflow/],
  ])("rejects %s", (_label, value, error) => {
    expect(() => validateDefinition(value, registry)).toThrow(error);
  });

  it("allows an outer node the loop transitively depends on in body refs and until", () => {
    expect(() => validateDefinition(base([
      tool("a"), tool("b", { dependsOn: ["a"] }),
      loop("l", [tool("t", { input: { path: "${nodes.a.output}" } })], { dependsOn: ["b"], until: "nodes.a.status == 'passed'" }),
    ]), registry)).not.toThrow();
  });

  describe("YAML", () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "agav-wf-loop-")); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    it("loads a YAML loop", async () => {
      const path = join(dir, "w.yaml");
      await writeFile(path, `version: 1
name: x
nodes:
  - id: l
    type: loop
    maxIterations: 4
    until: "nodes.t.status == 'passed'"
    body:
      - id: t
        type: tool
        tool: list_directory
        input:
          path: "."
`);
      const d = await loadDefinition(path, registry);
      expect(d.nodes[0]!.body![0]!.id).toBe("t");
      expect(d.nodes[0]!.maxIterations).toBe(4);
    });
  });
});

describe("loop executor outside a scheduler", () => {
  it("fails a loop dispatched without a sub-scope runner", async () => {
    const { store, cleanup } = await tempStore();
    try {
      const d = validateDefinition(base([loop("l", [tool("t")])]), registry);
      const run = await createRun(store, d, {});
      const cp = run.nodes[0]!;
      const result = await getNodeExecutor("loop").execute({ store, run, node: d.nodes[0]!, checkpoint: cp, registry, config: {} as never, signal: new AbortController().signal, resuming: false });
      expect(result.next).toBe("stop");
      expect(cp.status).toBe("failed");
      expect(cp.error).toBe("loop execution unavailable in this context");
    } finally { await cleanup(); }
  });
});

describe("loop checkpoints", () => {
  let store: WorkflowStore, cleanup: () => Promise<void>;
  beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
  afterEach(async () => { await cleanup(); });

  const nested = base([loop("outer", [
    { id: "j", type: "job", command: "echo hi" },
    loop("inner", [tool("t")], { dependsOn: ["j"], maxIterations: 2 }),
  ])]) as WorkflowDefinition;
  const runPath = (id: string) => join(store.root, `${id}.json`);
  async function rawRun(id: string): Promise<WorkflowRun> { return JSON.parse(await readFile(runPath(id), "utf8")) as WorkflowRun; }
  async function writeRaw(run: WorkflowRun): Promise<void> { await writeFile(runPath(run.id), JSON.stringify(run)); }

  /** outer iteration 0 passed; iteration 1 running with its job and inner iteration 0 pending. */
  function nestedState(r: WorkflowRun): LoopNodeCheckpoint {
    const scope0 = { loopPath: [{ loopId: "outer", iteration: 0 }] }, scope1 = { loopPath: [{ loopId: "outer", iteration: 1 }] };
    const cp: LoopNodeCheckpoint = {
      id: "outer", status: "running", iteration: 1, iterations: [
        { index: 0, status: "passed", nodes: {
          j: { id: "j", status: "passed", job: { requestId: jobRequestId(r.id, "j", 1, scope0), jobId: "job-1", state: "completed", exitCode: 0 } },
          inner: { id: "inner", status: "passed", iteration: 0, iterations: [{ index: 0, status: "passed", nodes: { t: { id: "t", status: "passed", output: "ok" } } }] } as LoopNodeCheckpoint,
        } },
        { index: 1, status: "running", nodes: {
          j: { id: "j", status: "running", job: { requestId: jobRequestId(r.id, "j", 1, scope1), jobId: "job-2", state: "running" } },
          inner: { id: "inner", status: "pending" },
        } },
      ],
    };
    r.status = "running"; r.nodes[0] = cp; r.executionCount = 2;
    return cp;
  }

  it("rejects two running nodes when one is inside a loop body (run-state invariant)", async () => {
    const d = base([tool("a"), loop("l", [tool("t")])]) as WorkflowDefinition;
    const run = await createRun(store, d, {});
    const raw = await rawRun(run.id);
    raw.status = "running";
    raw.nodes[1] = { id: "l", status: "running", iteration: 0, iterations: [{ index: 0, status: "running", nodes: { t: { id: "t", status: "running" } } }] } as LoopNodeCheckpoint;
    await writeRaw(raw);
    await expect(store.read(run.id, registry)).resolves.toBeDefined(); // one running body node is fine
    raw.nodes[0] = { id: "a", status: "running" };
    await writeRaw(raw);
    await expect(store.read(run.id, registry)).rejects.toThrow(/invalid run state/);
  });

  it("scoped requestIds pass the real background-jobs validator, stay unambiguous and are short", () => {
    const runId = "12345678-1234-4234-8234-123456789abc", nodeId = "n".repeat(64);
    const scopes = [undefined, { loopPath: [{ loopId: "l", iteration: 199 }] }, { loopPath: [{ loopId: "a", iteration: 0 }, { loopId: "b", iteration: 199 }] }];
    const ids = new Set<string>();
    for (const scope of scopes) for (const attempt of [1, 12]) {
      const id = jobRequestId(runId, nodeId, attempt, scope);
      expect(() => specPath("/x", id)).not.toThrow();
      expect(id.length).toBeLessThan(120);
      expect(jobAttempt(id, runId, nodeId, scope)).toBe(attempt);
      ids.add(id);
    }
    expect(ids.size).toBe(6);
    // Another scope or node never claims the id.
    expect(jobAttempt(jobRequestId(runId, "n", 1, scopes[1]), runId, "n", scopes[2])).toBeUndefined();
    expect(jobAttempt(jobRequestId(runId, "n", 1, scopes[1]), runId, "n")).toBeUndefined();
    expect(jobAttempt(jobRequestId(runId, "n", 1), runId, "n", scopes[1])).toBeUndefined();
    expect(jobAttempt(jobRequestId(runId, "n", 1, { loopPath: [{ loopId: "l", iteration: 1 }] }), runId, "n", { loopPath: [{ loopId: "l", iteration: 11 }] })).toBeUndefined();
  });

  it("formats scoped job requestIds and keeps the top-level format", () => {
    expect(jobRequestId("r", "n")).toBe("wf-r-n-1");
    expect(jobRequestId("r", "n", 2, { loopPath: [{ loopId: "l", iteration: 3 }] })).toBe("wf-r-n-2_i3");
    expect(jobRequestId("r", "n", 1, { loopPath: [{ loopId: "a", iteration: 0 }, { loopId: "b", iteration: 1 }] })).toBe("wf-r-n-1_i0_i1");
  });

  it("reads a valid nested checkpoint with scoped job requestIds", async () => {
    const run = await createRun(store, nested, {});
    const raw = await rawRun(run.id);
    nestedState(raw);
    await writeRaw(raw);
    const read = await store.read(run.id, registry);
    const cp = read.nodes[0] as LoopNodeCheckpoint;
    expect(cp.iterations![1]!.nodes.j!.job!.requestId).toBe(`wf-${run.id}-j-1_i1`);
    expect(read.executionCount).toBe(2);
  });

  it.each([
    ["bad iteration order", (r: WorkflowRun) => { const cp = nestedState(r); cp.iterations![0]!.index = 1; cp.iterations![1]!.index = 0; }],
    ["non-terminal iteration before the last", (r: WorkflowRun) => { const cp = nestedState(r); cp.iterations![0]!.status = "running"; }],
    ["more iterations than maxIterations", (r: WorkflowRun) => { const cp = nestedState(r); const inner = cp.iterations![0]!.nodes.inner as LoopNodeCheckpoint; inner.iterations = [0, 1, 2].map(index => ({ index, status: "passed" as const, nodes: { t: { id: "t", status: "passed" as const } } })); }],
    ["unscoped job requestId in a body", (r: WorkflowRun) => { const cp = nestedState(r); cp.iterations![1]!.nodes.j!.job!.requestId = jobRequestId(r.id, "j"); }],
    ["wrong iteration in a scoped requestId", (r: WorkflowRun) => { const cp = nestedState(r); cp.iterations![1]!.nodes.j!.job!.requestId = jobRequestId(r.id, "j", 1, { loopPath: [{ loopId: "outer", iteration: 0 }] }); }],
    ["body job running without identity", (r: WorkflowRun) => { const cp = nestedState(r); delete cp.iterations![1]!.nodes.j!.job; }],
    ["body attempt without retry", (r: WorkflowRun) => { const cp = nestedState(r); cp.iterations![1]!.nodes.j!.attempt = 2; }],
    ["body node with unsatisfied dependency", (r: WorkflowRun) => { const cp = nestedState(r); cp.iterations![0]!.nodes.j!.status = "failed"; }],
    ["missing body checkpoint", (r: WorkflowRun) => { const cp = nestedState(r); delete cp.iterations![1]!.nodes.inner; }],
    ["negative executionCount", (r: WorkflowRun) => { nestedState(r); r.executionCount = -1; }],
  ])("rejects %s", async (_label, mutate) => {
    const run = await createRun(store, nested, {});
    const raw = await rawRun(run.id);
    mutate(raw);
    await writeRaw(raw);
    await expect(store.read(run.id, registry)).rejects.toThrow(/Corrupt workflow checkpoint|Invalid workflow checkpoint/);
  });
});
