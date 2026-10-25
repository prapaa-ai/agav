import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentInvokeRequest, AgentInvoker } from "../workflows/agent-invoker.js";
import { decide, listPendingDecisions } from "../workflows/decisions.js";
import { readEvents } from "../workflows/events.js";
import { buildConsent, clampConsent, consentSession } from "../workflows/grant.js";
import { launchRun } from "../workflows/launch.js";
import { admitQueuedRuns, reconcileRun, reconcileRuns } from "../workflows/reconcile.js";
import { runnerJobDeps, startRunner } from "../workflows/runner.js";
import { createRun } from "../workflows/runtime.js";
import type { PermissionMode } from "../config/config.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, root: string, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, root, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const CLI = "/opt/agav/build/cli.js";
const SECRET = "s3cr3t-token-value-B";

async function consented(definition: WorkflowDefinition, mode: PermissionMode, envNames: string[] = []): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, mode, envNames);
  await store.lock(run.id, () => store.save(run));
  return run;
}
const runner = (id: string, coordinator: FakeCoordinator, config = testConfig(), extra: Record<string, unknown> = {}) =>
  startRunner(id, { store, registry, config, getCoordinator: async () => coordinator, jobDepsOverrides: { pollIntervalMs: 5 }, ...extra });

describe("org permission floor vs a stored consent (issue 2)", () => {
  const gate = { id: "gate", type: "approval" as const, prompt: "go?" };
  const toolDefFor = (path: string): WorkflowDefinition => def([gate, { id: "w", type: "tool", tool: "write_file", input: { path, content: "x" }, dependsOn: ["gate"] }]);
  const jobDef = def([gate, { id: "j", type: "job", command: "echo hi", dependsOn: ["gate"] }]);

  async function parkThenApprove(definition: WorkflowDefinition, coordinator: FakeCoordinator): Promise<WorkflowRun> {
    const run = await consented(definition, "auto-accept");
    // First attempt under the loose mode the user consented to, with no org floor: parks on the approval node.
    expect((await runner(run.id, coordinator).done).status).toBe("waiting_approval");
    const [pending] = await listPendingDecisions(store, run.id);
    await decide(store, run.id, pending!.decisionId, true, "u@h");
    return run;
  }

  it("a stored auto-accept parked run resumed under a deny-writes floor writes nothing (tool node)", async () => {
    const target = join(root, "must-not-exist.txt");
    const coordinator = new FakeCoordinator();
    const run = await parkThenApprove(toolDefFor(target), coordinator);
    const settled = await runner(run.id, coordinator, testConfig({ permissionMode: "auto-accept", orgPermissionFloor: "deny-writes" })).done;
    expect(settled.nodes.find(cp => cp.id === "w")).toMatchObject({ status: "failed", error: expect.stringMatching(/denied/i) });
    expect(existsSync(target)).toBe(false);
  });

  it("a stored auto-accept parked run resumed under a deny-writes floor starts no job", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parkThenApprove(jobDef, coordinator);
    const settled = await runner(run.id, coordinator, testConfig({ permissionMode: "auto-accept", orgPermissionFloor: "deny-writes" })).done;
    expect(settled.nodes.find(cp => cp.id === "j")?.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
  });

  it("an ask floor does not let stored auto-accept coverage bypass confirmation: the tool parks, nothing is written", async () => {
    const target = join(root, "must-not-exist-ask.txt");
    const coordinator = new FakeCoordinator();
    const run = await parkThenApprove(toolDefFor(target), coordinator);
    const settled = await runner(run.id, coordinator, testConfig({ permissionMode: "auto-accept", orgPermissionFloor: "ask" })).done;
    expect(settled.status).toBe("waiting_approval");
    expect(settled.nodes.find(cp => cp.id === "w")).toMatchObject({ status: "waiting_approval", decisionId: expect.stringMatching(/^dec_/) });
    expect(existsSync(target)).toBe(false);
  });

  it("an ask floor does not let the stored headless `start` approval start the covered job", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parkThenApprove(jobDef, coordinator);
    const settled = await runner(run.id, coordinator, testConfig({ permissionMode: "auto-accept", orgPermissionFloor: "ask" })).done;
    expect(settled.nodes.find(cp => cp.id === "j")?.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
  });

  it("without a floor the stored consent behaves as before (control)", async () => {
    const coordinator = new FakeCoordinator();
    const run = await parkThenApprove(jobDef, coordinator);
    expect((await runner(run.id, coordinator).done).status).toBe("passed");
    expect(coordinator.starts).toHaveLength(1);
  });

  it("agent nodes see the clamped mode, not the stored one", async () => {
    const requests: AgentInvokeRequest[] = [];
    const invoker: AgentInvoker = { async invoke(req) { requests.push(req); return { text: "ok", durationMs: 1 }; } };
    const run = await consented(def([{ id: "p", type: "prompt", prompt: "hi" }]), "auto-accept");
    const settled = await runner(run.id, new FakeCoordinator(), testConfig({ orgPermissionFloor: "deny-writes" }), { agentDeps: { getInvoker: () => invoker } }).done;
    expect(settled.status).toBe("passed");
    expect(requests[0]!.permissionMode).toBe("deny-writes");
    // The agent's sub-tool confirmations are refused under deny-writes.
    expect(await requests[0]!.confirmTool("write_file", { path: "a", content: "b" })).toBe(false);
  });

  it("consentSession / clampConsent only tighten, and keep `stop` available", () => {
    const consent = buildConsent(def([{ id: "j", type: "job", command: "echo hi" }]), "/w", "auto-accept", []);
    expect(consentSession(consent, ["start", "stop"])).toMatchObject({ permissionMode: "auto-accept", headlessApprovedActions: ["start", "stop"] });
    expect(consentSession(consent, ["start", "stop"], undefined, "auto-accept")).toMatchObject({ headlessApprovedActions: ["start", "stop"] });
    expect(consentSession(consent, ["start", "stop"], undefined, "deny-writes")).toMatchObject({ permissionMode: "deny-writes", headlessApprovedActions: ["stop"] });
    expect(consentSession(consent, ["start", "stop"], undefined, "ask")).toMatchObject({ permissionMode: "auto-accept", headlessApprovedActions: ["stop"] });
    expect(clampConsent(consent, "ask")).toMatchObject({ permissionMode: "ask", capabilities: { tools: [], jobCommands: [] } });
    expect(clampConsent(consent, undefined)).toBe(consent);
    const strict = buildConsent(def([{ id: "j", type: "job", command: "echo hi" }]), "/w", "deny-writes", []);
    expect(clampConsent(strict, "ask")).toBe(strict);
  });

  it("runnerJobDeps refuses a covered command under a tightening floor", async () => {
    const coordinator = new FakeCoordinator();
    const consent = buildConsent(def([{ id: "j", type: "job", command: "echo hi" }]), "/w", "auto-accept", []);
    const request = { requestId: "r", invocation: { mode: "shell", commandText: "echo hi" } } as never;
    await expect(runnerJobDeps(consent, async () => coordinator, false, {}, "ask").getCoordinator().then(c => c.start(request, { permissionMode: "auto-accept", headlessApprovedActions: ["start"] }))).rejects.toThrow(/not covered/);
    await runnerJobDeps(consent, async () => coordinator, false, {}).getCoordinator().then(c => c.start(request, { permissionMode: "auto-accept", headlessApprovedActions: ["start"] }));
    expect(coordinator.starts).toHaveLength(1);
  });
});

describe("queued admission and selected environment (issue 4)", () => {
  const jobDef = def([{ id: "a", type: "job", command: "echo hi" }]);

  async function queuedPair(envB: string[]): Promise<{ a: WorkflowRun; b: WorkflowRun; runners: FakeCoordinator; deps: { coordinator: FakeCoordinator; cliPath: string; maxConcurrentWorkflowRuns: number } }> {
    const runners = new FakeCoordinator();
    const a = await consented(jobDef, "ask", []); // A selected no token
    const b = await consented(jobDef, "ask", envB);
    const deps = { coordinator: runners, cliPath: CLI, maxConcurrentWorkflowRuns: 1 };
    expect((await launchRun(store, a.id, deps)).status).toBe("started");
    expect((await launchRun(store, b.id, deps)).status).toBe("queued");
    return { a, b, runners, deps };
  }

  it("a finishing runner without B's token leaves B queued with an explicit reason; a capable context then launches it", async () => {
    const { a, b, runners, deps } = await queuedPair(["B_TOKEN"]);
    const handle = runner(a.id, new FakeCoordinator(), testConfig(), { admitQueued: { ...deps, admissionEnv: {} } });
    expect((await handle.done).status).toBe("passed");
    expect(runners.starts.map(request => request.requestId)).toEqual([`wf-run-${a.id}-1`]);
    const queued = await store.read(b.id, registry);
    expect(queued.status).toBe("queued");
    expect(queued.runner?.jobId).toBeUndefined();
    expect((await readEvents(store, b.id)).filter(event => event.type === "run_status").at(-1)).toMatchObject({ status: "queued", reason: expect.stringContaining("B_TOKEN") });

    // Handoff: a parent / tick / TUI whose environment has the token admits it, passing the NAME only.
    const result = await reconcileRuns(store, { ...deps, admissionEnv: { B_TOKEN: SECRET }, exitingRunId: a.id });
    expect(result).toContainEqual({ runId: b.id, action: "admitted" });
    expect(runners.starts.at(-1)).toMatchObject({ requestId: `wf-run-${b.id}-1`, envInherit: ["B_TOKEN"] });
    expect(JSON.stringify(runners.starts)).not.toContain(SECRET);
  });

  it("the deferral does not repeat events on every reconcile pass and never persists the value", async () => {
    const { a, b, deps } = await queuedPair(["B_TOKEN"]);
    for (let i = 0; i < 3; i++) {
      const results = await admitQueuedRuns(store, { ...deps, exitingRunId: a.id, admissionEnv: { OTHER: SECRET } });
      expect(results.filter(result => result.runId === b.id)).toEqual([{ runId: b.id, action: "queued", reason: expect.stringContaining("B_TOKEN") }]);
    }
    const reasons = (await readEvents(store, b.id)).filter(event => event.type === "run_status" && event.reason?.includes("B_TOKEN"));
    expect(reasons).toHaveLength(1);
    const files = [store.root, store.runDir(b.id)].flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json") || name.endsWith(".jsonl")).map(name => readFileSync(join(dir, name), "utf8")) : []);
    expect(files.join("\n")).not.toContain(SECRET);
  });

  it("a queued run that selected no env is still admitted by a restricted runner", async () => {
    const { a, b, runners, deps } = await queuedPair([]);
    await runner(a.id, new FakeCoordinator(), testConfig(), { admitQueued: { ...deps, admissionEnv: {} } }).done;
    expect(runners.starts.map(request => request.requestId)).toEqual([`wf-run-${a.id}-1`, `wf-run-${b.id}-1`]);
    expect((await store.read(b.id, registry)).runner?.jobId).toBe("job-2");
  });

  it("defaults to process.env (what the in-process coordinator resolves)", async () => {
    const { b, deps } = await queuedPair(["AGAV_TEST_ADMISSION_TOKEN"]);
    delete process.env.AGAV_TEST_ADMISSION_TOKEN;
    expect((await reconcileRun(store, b.id, deps))).toMatchObject({ action: "queued", reason: expect.stringContaining("AGAV_TEST_ADMISSION_TOKEN") });
    process.env.AGAV_TEST_ADMISSION_TOKEN = SECRET;
    try { expect((await reconcileRun(store, b.id, { ...deps, maxConcurrentWorkflowRuns: 2 })).action).toBe("admitted"); }
    finally { delete process.env.AGAV_TEST_ADMISSION_TOKEN; }
  });

  it("a dead runner is not relaunched from a context lacking the selected env, and is left for a capable one", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented(jobDef, "ask", ["B_TOKEN"]);
    await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { B_TOKEN: SECRET } });
    const running = await store.read(run.id, registry);
    running.status = "running";
    await store.lock(run.id, () => store.save(running));
    const job = [...coordinator.jobs.values()][0]!;
    coordinator.jobs.set(job.jobId, { ...job, state: "failed" });
    expect(await reconcileRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: {} })).toMatchObject({ action: "none", reason: expect.stringContaining("B_TOKEN") });
    expect(coordinator.starts).toHaveLength(1);
    expect((await store.read(run.id, registry)).status).toBe("running");
    expect((await reconcileRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { B_TOKEN: SECRET } })).action).toBe("relaunched");
    expect(coordinator.starts).toHaveLength(2);
  });
});
