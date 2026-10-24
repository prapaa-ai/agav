import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { AgentInvokeRequest, AgentInvoker } from "../workflows/agent-invoker.js";
import type { AgentNodeDeps } from "../workflows/agent-node.js";
import { runSummary } from "../workflows/background.js";
import { narrowPermissionMode, validateDefinition, type WorkflowDefinition } from "../workflows/definition.js";
import { readEvents } from "../workflows/events.js";
import type { WorkflowExecutionHost } from "../workflows/gated-tools.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { jobRequestId, type WorkflowStore } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, jobDeps, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });
const config = testConfig();

/** Invoker whose replies are taken in order (the last repeats); a function reply may throw or wait. */
function invoker(...replies: Array<string | ((req: AgentInvokeRequest) => Promise<string>)>): AgentInvoker & { calls: number } {
  const self = {
    calls: 0,
    async invoke(req: AgentInvokeRequest) {
      const reply = replies[Math.min(self.calls++, replies.length - 1)]!;
      return { text: typeof reply === "string" ? reply : await reply(req), durationMs: 1 };
    },
  };
  return self;
}
const agentDeps = (inv: AgentInvoker): AgentNodeDeps => ({ getInvoker: () => inv, loadAgents: async () => [] });
/** Resolves once `signal` aborts (a cooperative long-running operation). */
const untilAborted = (signal: AbortSignal): Promise<void> => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
/** Host whose read_file blocks until its abort signal fires. */
function hangingHost(): WorkflowExecutionHost {
  return { confirmTool: async () => true, executeTool: async (_r, _n, _i, context) => { await untilAborted(context.signal!); return { output: "aborted", isError: true }; } };
}
async function run(definition: WorkflowDefinition, opts: { host?: WorkflowExecutionHost; coordinator?: FakeCoordinator; inv?: AgentInvoker; inputs?: Record<string, unknown>; cfg?: typeof config } = {}) {
  const created = await createRun(store, validateDefinition(definition, registry), opts.inputs ?? {});
  const done = await executeRun(store, created.id, registry, opts.cfg ?? config, undefined, opts.host ?? fakeHost(), opts.coordinator ? jobDeps(opts.coordinator) : undefined, opts.inv ? agentDeps(opts.inv) : undefined);
  // Every settled checkpoint must also be readable (store validation of the new fields).
  await expect(store.read(created.id, registry)).resolves.toBeTruthy();
  return done;
}
const statuses = (r: { nodes: Array<{ id: string; status: string }> }) => Object.fromEntries(r.nodes.map(n => [n.id, n.status]));
const read = (id: string) => ({ id, type: "tool" as const, tool: "read_file", input: { path: id } });

describe("when conditions", () => {
  it("skips a node whose when is false and cascades the skip unless allowSkipped", async () => {
    const host = fakeHost();
    const done = await run(def([
      { ...read("a"), when: "inputs.env == 'prod'" },
      { ...read("b"), dependsOn: ["a"] },
      { ...read("c"), dependsOn: ["a"], allowSkipped: true, when: "nodes.a.status != 'passed'" },
      { ...read("d"), when: "${inputs.env == 'dev'}" },
    ], { inputs: { env: { type: "string" } } }), { host, inputs: { env: "dev" } });
    expect(statuses(done)).toEqual({ a: "skipped", b: "skipped", c: "passed", d: "passed" });
    expect(done.status).toBe("passed");
    expect(done.nodes[0]!.error).toMatch(/when is false/);
    expect(done.nodes[1]!.error).toMatch(/dependency a was skipped/);
    expect(host.calls.map(c => c.input.path)).toEqual(["c", "d"]);
    expect(runSummary(done)).toContain("a: skipped");
  });

  it("runs the node when the condition is true and reads dependency outputs", async () => {
    const host = fakeHost({ read_file: { output: "ready", isError: false } });
    const done = await run(def([read("a"), { ...read("b"), dependsOn: ["a"], when: "'read' in nodes.a.output" }]), { host });
    expect(statuses(done)).toEqual({ a: "passed", b: "passed" });
  });

  it("validates when at definition time", () => {
    const v = (nodes: unknown[]) => () => validateDefinition({ version: 1, name: "x", nodes }, registry);
    expect(v([{ ...read("a"), when: "inputs.x ==" }])).toThrow(/invalid when/);
    expect(v([read("a"), { ...read("b"), when: "nodes.a.status == 'passed'" }])).toThrow(/not one of its dependencies/);
    expect(v([{ ...read("b"), when: "nodes.zz.status == 'passed'" }])).toThrow(/unknown node "zz"/);
    expect(v([{ ...read("b"), when: "inputs.__proto__" }])).toThrow(/forbidden/);
    expect(v([read("a"), { ...read("b"), dependsOn: ["a"], when: "nodes.a.status == 'passed'", allowSkipped: true }])).not.toThrow();
  });
});

describe("retries", () => {
  it("a retried agent node succeeds on attempt 2", async () => {
    const inv = invoker(async () => { throw new Error("flaky"); }, "fine");
    const done = await run(def([{ id: "a", type: "prompt", prompt: "go", retry: { max: 2, backoffSeconds: 0 } }]), { inv });
    expect(done.status).toBe("passed");
    expect(done.nodes[0]).toMatchObject({ status: "passed", attempt: 2, output: "fine" });
    expect(inv.calls).toBe(2);
    expect((await readEvents(store, done.id)).filter(e => e.type === "node_retry")).toMatchObject([{ nodeId: "a", attempt: 2, error: "flaky" }]);
  });

  it("stops after retry.max retries and reports attempt n/max", async () => {
    const inv = invoker(async () => { throw new Error("always"); });
    const done = await run(def([{ id: "a", type: "prompt", prompt: "go", retry: { max: 2 } }]), { inv });
    expect(done.status).toBe("failed");
    expect(done.nodes[0]).toMatchObject({ status: "failed", attempt: 3 });
    expect(inv.calls).toBe(3);
    expect(runSummary(done)).toContain("a: failed (attempt 3/3)");
  });

  it("a retried job uses requestId -2 and starts a new job", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = ["failed", "completed"];
    const done = await run(def([{ id: "j", type: "job", command: "make test", retry: { max: 1 } }]), { coordinator });
    expect(done.status).toBe("passed");
    expect(coordinator.starts.map(s => s.requestId)).toEqual([jobRequestId(done.id, "j", 1), jobRequestId(done.id, "j", 2)]);
    expect(done.nodes[0]!.job).toMatchObject({ requestId: `wf-${done.id}-j-2`, jobId: "job-2" });
    expect(done.nodes[0]!.attempt).toBe(2);
  });

  it("backoff is cancellable by the run signal", async () => {
    const created = await createRun(store, def([{ id: "a", type: "prompt", prompt: "go", retry: { max: 3, backoffSeconds: 3600 } }]), {});
    const controller = new AbortController();
    const inv = invoker(async () => { setTimeout(() => controller.abort(), 20); throw new Error("flaky"); });
    const started = Date.now();
    const done = await executeRun(store, created.id, registry, config, controller.signal, fakeHost(), undefined, agentDeps(inv));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(done.status).toBe("cancelled");
    expect(inv.calls).toBe(1);
  });

  it("allows retry on read-only tools and rejects it on mutating tools and approvals", async () => {
    const v = (nodes: unknown[]) => () => validateDefinition({ version: 1, name: "x", nodes }, registry);
    expect(v([{ ...read("a"), retry: { max: 2 } }])).not.toThrow();
    expect(v([{ id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "c" }, retry: { max: 1 } }])).toThrow(/retry is only allowed for read-only tools/);
    expect(v([{ id: "r", type: "tool", tool: "run_command", input: { command: "ls" }, retry: { max: 1 } }])).toThrow(/retry is only allowed for read-only tools/);
    expect(v([{ id: "p", type: "approval", prompt: "ok?", retry: { max: 1 } }])).toThrow(/Approval nodes do not support retry/);
    expect(v([{ ...read("a"), retry: { max: 11 } }])).toThrow(/Invalid workflow/);
    expect(v([{ ...read("a"), retry: { max: 1, backoffSeconds: 4000 } }])).toThrow(/Invalid workflow/);
    expect(v([{ ...read("a"), retry: { max: 1, extra: 1 } }])).toThrow(/Invalid workflow/);
    const host = fakeHost({ read_file: { output: "nope", isError: true } });
    const done = await run(def([{ ...read("a"), retry: { max: 1 } }]), { host });
    expect(host.calls).toHaveLength(2);
    expect(done.nodes[0]).toMatchObject({ status: "failed", attempt: 2 });
  });
});

describe("timeouts", () => {
  it("a tool node timeout aborts the tool and gives timed_out", async () => {
    const done = await run(def([{ ...read("a"), timeoutSeconds: 0.05 }]), { host: hangingHost() });
    expect(done.nodes[0]!.status).toBe("timed_out");
    expect(done.status).toBe("timed_out");
  });

  it("an agent node timeout aborts the agent and gives timed_out", async () => {
    let aborted = false;
    const inv = invoker(async req => { await untilAborted(req.signal); aborted = true; throw new Error("aborted"); });
    const done = await run(def([{ id: "a", type: "prompt", prompt: "go", timeoutSeconds: 0.05 }]), { inv });
    expect(aborted).toBe(true);
    expect(done.nodes[0]!.status).toBe("timed_out");
    expect(done.status).toBe("timed_out");
  });

  it("a job node timeout explicitly stops the job and gives timed_out", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = ["running"];
    const done = await run(def([{ id: "j", type: "job", command: "sleep 100", timeoutSeconds: 0.1 }]), { coordinator });
    expect(coordinator.stops).toEqual(["job-1"]);
    expect(done.nodes[0]!.status).toBe("timed_out");
    expect(done.nodes[0]!.error).toMatch(/Timed out after 0.1s; the job was stopped/);
    expect(done.status).toBe("timed_out");
  });

  it("validates timeoutSeconds: allowed on jobs, rejected on approvals", () => {
    const v = (nodes: unknown[]) => () => validateDefinition({ version: 1, name: "x", nodes }, registry);
    expect(v([{ id: "j", type: "job", command: "echo", timeoutSeconds: 5, retry: { max: 1 } }])).not.toThrow();
    expect(v([{ id: "p", type: "approval", prompt: "ok?", timeoutSeconds: 5 }])).toThrow(/Approval nodes do not support timeoutSeconds/);
  });

  it("the run deadline aborts the running node and gives timed_out, and is persisted", async () => {
    const created = await createRun(store, def([read("a"), { ...read("b"), dependsOn: ["a"] }], { policies: { maxRuntimeSeconds: 0.1 } }), {});
    const done = await executeRun(store, created.id, registry, config, undefined, hangingHost());
    expect(done.status).toBe("timed_out");
    expect(statuses(done)).toEqual({ a: "timed_out", b: "pending" });
    expect(done.nodes[0]!.error).toMatch(/Run deadline exceeded/);
    const stored = await store.read(created.id, registry);
    expect(Date.parse(stored.deadlineAt!) - Date.parse(created.createdAt)).toBeLessThan(5000);
  });

  it("resume honors a persisted deadline that already passed", async () => {
    const created = await createRun(store, def([read("a")], { policies: { maxRuntimeSeconds: 60 } }), {});
    await store.lock(created.id, async () => { created.deadlineAt = new Date(Date.now() - 1000).toISOString(); await store.save(created); });
    const host = fakeHost();
    const done = await executeRun(store, created.id, registry, config, undefined, host);
    expect(done.status).toBe("timed_out");
    expect(host.calls).toHaveLength(0);
  });
});

describe("policies", () => {
  it("narrowPermissionMode only narrows", () => {
    expect(narrowPermissionMode("auto-accept", "ask")).toBe("ask");
    expect(narrowPermissionMode("auto-accept", "deny-writes")).toBe("deny-writes");
    expect(narrowPermissionMode("ask", "auto-accept")).toBe("ask");
    expect(narrowPermissionMode("deny-writes", "auto-accept")).toBe("deny-writes");
    expect(narrowPermissionMode("ask", undefined)).toBe("ask");
  });

  it("permissionMode narrows the session mode for tool nodes", async () => {
    const write = { id: "w", type: "tool" as const, tool: "write_file", input: { path: "o", content: "c" } };
    const host = fakeHost();
    const done = await run(def([write], { policies: { permissionMode: "deny-writes" } }), { host, cfg: testConfig({ permissionMode: "auto-accept" }) });
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/denied/);
    expect(host.calls).toHaveLength(0);
  });

  it("permissionMode cannot widen the session mode", async () => {
    const write = { id: "w", type: "tool" as const, tool: "write_file", input: { path: "o", content: "c" } };
    const host = fakeHost();
    const done = await run(def([write], { policies: { permissionMode: "auto-accept" } }), { host, cfg: testConfig({ permissionMode: "deny-writes" }) });
    expect(done.status).toBe("failed");
    expect(host.calls).toHaveLength(0);
    // ask stays ask: the host is still asked to confirm.
    let asked = 0;
    const askHost = { ...fakeHost(), confirmTool: async () => { asked++; return true; } };
    const ok = await run(def([write], { policies: { permissionMode: "auto-accept" } }), { host: askHost, cfg: testConfig({ permissionMode: "ask" }) });
    expect(ok.status).toBe("passed");
    expect(asked).toBe(1);
  });

  it("permissionMode narrows agent sub-tool decisions", async () => {
    let approved: boolean | undefined;
    const inv = invoker(async req => { approved = await req.confirmTool("write_file", { path: "o", content: "c" }); return "done"; });
    await run(def([{ id: "a", type: "prompt", prompt: "go", allowedTools: ["write_file"] }], { policies: { permissionMode: "deny-writes" } }), { inv, cfg: testConfig({ permissionMode: "auto-accept" }) });
    expect(approved).toBe(false);
  });

  it("stopOnFailure:false keeps independent branches running, skips dependents and ends failed", async () => {
    // b is skipped because a failed; c accepts the skipped b (allowSkipped) and runs; e (no allowSkipped) cascades.
    const host = fakeHost({ read_file: input => ({ output: String(input.path), isError: input.path === "a" }) });
    const done = await run(def([
      read("a"),
      { ...read("b"), dependsOn: ["a"] },
      { ...read("c"), dependsOn: ["b"], allowSkipped: true },
      { ...read("e"), dependsOn: ["b"] },
      read("d"),
    ], { policies: { stopOnFailure: false, maxConcurrency: 2 } }), { host });
    expect(statuses(done)).toEqual({ a: "failed", b: "skipped", c: "passed", e: "skipped", d: "passed" });
    expect(done.nodes[1]!.error).toMatch(/dependency a failed/);
    expect(done.status).toBe("failed");
    expect(host.calls.map(c => c.input.path)).toEqual(["a", "c", "d"]);
  });

  it("stopOnFailure defaults to true", async () => {
    const host = fakeHost({ read_file: input => ({ output: "x", isError: input.path === "a" }) });
    const done = await run(def([read("a"), read("d")]), { host });
    expect(statuses(done)).toEqual({ a: "failed", d: "pending" });
  });

  it("rejects unknown policy fields", () => {
    expect(() => validateDefinition({ version: 1, name: "x", nodes: [read("a")], policies: { nope: 1 } }, registry)).toThrow(/Invalid workflow/);
    expect(() => validateDefinition({ version: 1, name: "x", nodes: [read("a")], policies: { permissionMode: "yolo" } }, registry)).toThrow(/Invalid workflow/);
  });
});

describe("continueOnError (top level)", () => {
  it("a tolerated failure does not stop the run; dependents branch on its status", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = ["failed"];
    const inv = invoker("reported");
    const done = await run(def([
      { id: "test", type: "job", command: "npm test", continueOnError: true },
      { id: "report", type: "prompt", prompt: "tests ${nodes.test.status}", dependsOn: ["test"], when: "nodes.test.status == 'failed'" },
      { id: "ship", type: "tool", tool: "read_file", input: { path: "x" }, dependsOn: ["test"], when: "nodes.test.status == 'passed'" },
    ]), { coordinator, inv });
    expect(done.status).toBe("passed");
    expect(done.nodes.map(cp => cp.status)).toEqual(["failed", "passed", "skipped"]);
    expect(inv.calls).toBe(1);
  });

  it("is rejected on loop and approval nodes", () => {
    expect(() => validateDefinition(def([{ id: "a", type: "approval", prompt: "ok?", continueOnError: true }]), registry)).toThrow(/continueOnError is not supported on approval/);
    expect(() => validateDefinition(def([{ id: "l", type: "loop", maxIterations: 2, continueOnError: true, body: [{ id: "b", type: "prompt", prompt: "p" }] }]), registry)).toThrow(/continueOnError is not supported on loop/);
  });
});
