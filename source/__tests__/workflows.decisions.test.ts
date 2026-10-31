import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobSummary } from "../background-jobs/types.js";
import { decideApproval, decideRunDecision, resolveDecisionTarget } from "../workflows/control.js";
import {
  canonicalJson, createPendingDecision, decide, decisionIdFor, inputHash, listPendingDecisions, readDecision, resolvedInput,
} from "../workflows/decisions.js";
import { readEvents } from "../workflows/events.js";
import { buildConsent } from "../workflows/grant.js";
import { createBackgroundHost } from "../workflows/hosts.js";
import { launchRun } from "../workflows/launch.js";
import { startRunner } from "../workflows/runner.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import type { WorkflowExecutionHost } from "../workflows/gated-tools.js";
import { def, FakeCoordinator, jobDeps, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const CLI = "/opt/agav/build/cli.js";
const askConfig = testConfig({ permissionMode: "ask" });

async function consented(definition: WorkflowDefinition, tools?: string[]): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "ask", []);
  if (tools) run.consent.capabilities.tools = tools;
  await store.lock(run.id, () => store.save(run));
  return run;
}
function setRunnerState(coordinator: FakeCoordinator, requestId: string, state: JobSummary["state"]): void {
  const job = [...coordinator.jobs.values()].find(item => item.requestId === requestId)!;
  coordinator.jobs.set(job.jobId, { ...job, state });
}
/** Background host whose tools never touch the filesystem; records executions. */
function inboxHost(run: WorkflowRun): WorkflowExecutionHost & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return { ...createBackgroundHost(run.consent!, { store, runId: run.id }), calls, executeTool: async (_registry, name, input) => { calls.push(input); return { output: `${name} ok`, isError: false }; } };
}

describe("decision records", () => {
  it("hashes canonical JSON (key order independent) and derives deterministic ids", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: "s" } })).toBe('{"a":{"c":"s","d":[1,{"x":1,"y":2}]},"b":1}');
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
    const r = resolvedInput("write_file", { path: "x", content: "1" });
    expect(decisionIdFor("tool_consent", "w", r)).toBe(decisionIdFor("tool_consent", "w", resolvedInput("write_file", { content: "1", path: "x" })));
    expect(decisionIdFor("tool_consent", "w", r)).not.toBe(decisionIdFor("tool_consent", "w", resolvedInput("write_file", { path: "x", content: "2" })));
    expect(decisionIdFor("tool_consent", "w", r)).not.toBe(decisionIdFor("tool_consent", "other", r));
  });

  it("createPendingDecision is idempotent and listPendingDecisions spans all runs", async () => {
    const a = await createRun(store, def([{ id: "g", type: "approval", prompt: "?" }]), {});
    const b = await createRun(store, def([{ id: "h", type: "approval", prompt: "?" }]), {});
    const first = await createPendingDecision(store, a.id, { kind: "approval", nodeId: "g", summary: "go?" });
    const again = await createPendingDecision(store, a.id, { kind: "approval", nodeId: "g", summary: "changed text" });
    expect(again).toEqual(first);
    await createPendingDecision(store, b.id, { kind: "approval", nodeId: "h", summary: "go?" });
    expect((await listPendingDecisions(store)).map(item => item.runId).sort()).toEqual([a.id, b.id].sort());
    expect(await listPendingDecisions(store, a.id)).toHaveLength(1);
    await decide(store, a.id, first.decisionId, true, "u@h");
    expect((await listPendingDecisions(store)).map(item => item.runId)).toEqual([b.id]);
    expect((await readDecision(store, a.id, first.decisionId))?.decided).toMatchObject({ decision: "approve", decidedBy: "u@h" });
  });

  it("two concurrent deciders produce exactly one winner", async () => {
    const run = await createRun(store, def([{ id: "g", type: "approval", prompt: "?" }]), {});
    const pending = await createPendingDecision(store, run.id, { kind: "approval", nodeId: "g", summary: "go?" });
    const results = await Promise.all([
      decide(store, run.id, pending.decisionId, true, "alice@h"),
      decide(store, run.id, pending.decisionId, false, "bob@h"),
      decide(store, run.id, pending.decisionId, true, "carol@h", "late"),
    ]);
    expect(results.filter(result => result.won)).toHaveLength(1);
    const winner = results.find(result => result.won)!.record;
    for (const result of results) expect(result.record).toEqual(winner);
    expect(JSON.parse(await readFile(join(store.runDir(run.id), "decisions", `${pending.decisionId}.decided.json`), "utf8"))).toEqual(winner);
  });
});

describe("approval parking", () => {
  const gated = def([{ id: "gate", type: "approval", prompt: "deploy?" }, { id: "j", type: "job", command: "echo hi", dependsOn: ["gate"] }]);

  it("parks the run and the runner exits; deciding from another session relaunches attempt+1 and the run passes", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented(gated);
    await launchRun(store, run.id, { coordinator, cliPath: CLI });
    const first = startRunner(run.id, { store, registry, config: askConfig, getCoordinator: async () => coordinator, jobDepsOverrides: { pollIntervalMs: 5 } });
    const parked = await first.done; // the runner returns (exits) instead of waiting
    expect(parked.status).toBe("waiting_approval");
    expect(parked.nodes[0]).toMatchObject({ status: "waiting_approval", decisionId: expect.stringMatching(/^dec_/) });
    expect((await readEvents(store, run.id)).some(event => event.type === "decision_requested")).toBe(true);
    setRunnerState(coordinator, `wf-run-${run.id}-1`, "completed"); // the runner process has exited

    // Another session decides: it writes only the decision file, then relaunches the runner.
    const decided = await decideApproval(store, run.id, "gate", true, { registry, by: "ops@box", launch: { coordinator, cliPath: CLI } });
    expect(decided.won).toBe(true);
    expect(decided.relaunch).not.toBe("live");
    expect(coordinator.starts.map(request => request.requestId)).toEqual([`wf-run-${run.id}-1`, `wf-run-${run.id}-2`]);
    expect((await store.read(run.id, registry)).runner).toMatchObject({ attempt: 2 });

    const second = startRunner(run.id, { store, registry, config: askConfig, getCoordinator: async () => coordinator, jobDepsOverrides: { pollIntervalMs: 5 } });
    const done = await second.done;
    expect(done.status).toBe("passed");
    expect(done.nodes[0]).toMatchObject({ status: "passed", decision: { decision: "approve", decidedBy: "ops@box" } });
    // A losing decider is told the decision was already made and nothing relaunches.
    const late = await decideRunDecision(store, run.id, decided.pending.decisionId, false, { registry, launch: { coordinator, cliPath: CLI } }).catch(error => error as Error);
    expect(late).toBeInstanceOf(Error); // the run is terminal now
    expect(coordinator.starts.filter(request => request.requestId.startsWith("wf-run-"))).toHaveLength(2);
  });

  it("a denied approval fails the resumed run", async () => {
    const coordinator = new FakeCoordinator();
    const run = await consented(gated);
    await launchRun(store, run.id, { coordinator, cliPath: CLI });
    await startRunner(run.id, { store, registry, config: askConfig, getCoordinator: async () => coordinator }).done;
    setRunnerState(coordinator, `wf-run-${run.id}-1`, "completed");
    await decideApproval(store, run.id, "gate", false, { registry, by: "ops@box", note: "not today", launch: { coordinator, cliPath: CLI } });
    const done = await startRunner(run.id, { store, registry, config: askConfig, getCoordinator: async () => coordinator }).done;
    expect(done.status).toBe("failed");
    expect(done.nodes[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/denied by ops@box: not today/) });
    expect(coordinator.starts.filter(request => !request.requestId.startsWith("wf-run-"))).toHaveLength(0);
  });

  it("a live runner applies a decision in-process without a relaunch", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.pollStates = [...Array<JobSummary["state"]>(30).fill("running"), "completed"];
    const definition = def([
      { id: "gate", type: "approval", prompt: "?" },
      { id: "slow", type: "job", command: "sleep 1" },
      { id: "after", type: "tool", tool: "list_directory", input: { path: "." }, dependsOn: ["gate"] },
    ]);
    const run = await consented(definition);
    const done = executeRun(store, run.id, registry, askConfig, undefined, inboxHost(run), jobDeps(coordinator));
    let pendingId: string | undefined;
    for (let i = 0; i < 300 && !pendingId; i++) { pendingId = (await listPendingDecisions(store, run.id))[0]?.decisionId; if (!pendingId) await new Promise(resolve => setTimeout(resolve, 5)); }
    expect(pendingId).toBeDefined();
    await decide(store, run.id, pendingId!, true, "u@h");
    const settled = await done;
    expect(settled.status).toBe("passed");
    expect(settled.nodes.map(cp => cp.status)).toEqual(["passed", "passed", "passed"]);
  });
});

describe("tool consent", () => {
  const writeDef = (content: string) => def([{ id: "w", type: "tool", tool: "write_file", input: { path: "out.txt", content } }]);

  it("parks on a pending decision bound to the resolved inputHash; approve runs exactly that input", async () => {
    const run = await consented(writeDef("v1"), []);
    const host = inboxHost(run);
    const parked = await executeRun(store, run.id, registry, askConfig, undefined, host);
    expect(parked.status).toBe("waiting_approval");
    expect(host.calls).toHaveLength(0);
    const [pending] = await listPendingDecisions(store, run.id);
    expect(pending).toMatchObject({ kind: "tool_consent", nodeId: "w", resolved: { toolName: "write_file", input: { path: "out.txt", content: "v1" }, inputHash: inputHash({ path: "out.txt", content: "v1" }) } });
    expect(await resolveDecisionTarget(store, run.id, "w")).toEqual(pending);
    await decide(store, run.id, pending!.decisionId, true, "u@h");
    const done = await executeRun(store, run.id, registry, askConfig, undefined, host);
    expect(done.status).toBe("passed");
    expect(host.calls).toEqual([{ path: "out.txt", content: "v1" }]);
  });

  it("a changed resolved input creates a new pending decision instead of reusing the approval", async () => {
    const run = await consented(def([{ id: "w", type: "tool", tool: "write_file", input: { path: "out.txt", content: "${inputs.v}" } }], { inputs: { v: { type: "string", default: "one" } } }), []);
    const host = inboxHost(run);
    await executeRun(store, run.id, registry, askConfig, undefined, host);
    const [first] = await listPendingDecisions(store, run.id);
    await decide(store, run.id, first!.decisionId, true, "u@h");
    // Same node, different resolved input (e.g. an upstream output changed): the old approval does not cover it.
    const raw = JSON.parse(await readFile(join(store.root, `${run.id}.json`), "utf8")) as WorkflowRun;
    raw.inputs = { v: "two" };
    await writeFile(join(store.root, `${run.id}.json`), JSON.stringify(raw));
    const again = await executeRun(store, run.id, registry, askConfig, undefined, host);
    expect(again.status).toBe("waiting_approval");
    expect(host.calls).toHaveLength(0);
    const [second] = await listPendingDecisions(store, run.id);
    expect(second!.decisionId).not.toBe(first!.decisionId);
    expect(second!.resolved).toMatchObject({ input: { content: "two" } });
  });

  it("identical calls reuse the decision (approve proceeds, deny refuses) without asking again", async () => {
    const run = await consented(writeDef("same"), []);
    const host = createBackgroundHost(run.consent!, { store, runId: run.id });
    const signal = new AbortController().signal;
    const input = { path: "out.txt", content: "same" };
    await expect(host.confirmTool("write_file", input, signal, { nodeId: "w" })).rejects.toThrow(/Waiting for decision/);
    await expect(host.confirmTool("write_file", { content: "same", path: "out.txt" }, signal, { nodeId: "w" })).rejects.toThrow(/Waiting for decision/);
    const pending = await listPendingDecisions(store, run.id);
    expect(pending).toHaveLength(1); // one decision for identical calls
    await decide(store, run.id, pending[0]!.decisionId, true, "u@h");
    expect(await host.confirmTool("write_file", input, signal, { nodeId: "w" })).toBe(true);
    expect(await host.confirmTool("write_file", { ...input }, signal, { nodeId: "w" })).toBe(true);
    expect(await listPendingDecisions(store, run.id)).toHaveLength(0);
    // A denied identical call is refused outright.
    const other = { path: "out.txt", content: "deny-me" };
    await expect(host.confirmTool("write_file", other, signal, { nodeId: "w" })).rejects.toThrow(/Waiting for decision/);
    await decide(store, run.id, (await listPendingDecisions(store, run.id))[0]!.decisionId, false, "u@h");
    expect(await host.confirmTool("write_file", other, signal, { nodeId: "w" })).toBe(false);
  });

  it("a denied tool consent fails the node on resume", async () => {
    const run = await consented(writeDef("x"), []);
    const host = inboxHost(run);
    await executeRun(store, run.id, registry, askConfig, undefined, host);
    await decide(store, run.id, (await listPendingDecisions(store, run.id))[0]!.decisionId, false, "u@h", "no");
    const done = await executeRun(store, run.id, registry, askConfig, undefined, host);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/permission denied by u@h: no/);
    expect(host.calls).toHaveLength(0);
  });
});

describe("uncertain_tool", () => {
  async function interrupted(): Promise<WorkflowRun> {
    const run = await consented(def([{ id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "c" } }]));
    const raw = JSON.parse(await readFile(join(store.root, `${run.id}.json`), "utf8")) as WorkflowRun;
    raw.status = "running"; raw.nodes[0] = { id: "w", status: "running", startedAt: new Date().toISOString() };
    await writeFile(join(store.root, `${run.id}.json`), JSON.stringify(raw));
    return run;
  }

  it("approve retries the node", async () => {
    const run = await interrupted();
    const host = inboxHost(run);
    expect((await executeRun(store, run.id, registry, askConfig, undefined, host)).status).toBe("waiting_approval");
    expect(host.calls).toHaveLength(0);
    const decided = await decideRunDecision(store, run.id, (await resolveDecisionTarget(store, run.id, "w", "uncertain_tool")).decisionId, true, { registry });
    expect(decided.won).toBe(true);
    const done = await executeRun(store, run.id, registry, askConfig, undefined, host);
    expect(done.status).toBe("passed");
    expect(host.calls).toHaveLength(1);
  });

  it("deny marks the node failed", async () => {
    const run = await interrupted();
    const host = inboxHost(run);
    await executeRun(store, run.id, registry, askConfig, undefined, host);
    await decide(store, run.id, (await listPendingDecisions(store, run.id))[0]!.decisionId, false, "u@h");
    const done = await executeRun(store, run.id, registry, askConfig, undefined, host);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/uncertain outcome; marked failed by u@h/);
    expect(host.calls).toHaveLength(0);
  });
});
