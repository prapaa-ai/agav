import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";
import { createDefaultAgentInvoker, type AgentInvokeRequest, type AgentInvokeResult, type AgentInvoker } from "../workflows/agent-invoker.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import type { AgentNodeDeps } from "../workflows/agent-node.js";
import { runSummary } from "../workflows/background.js";
import { decide, listPendingDecisions } from "../workflows/decisions.js";
import { validateDefinition, type WorkflowDefinition } from "../workflows/definition.js";
import { buildConsent } from "../workflows/grant.js";
import { createBackgroundHost } from "../workflows/hosts.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import type { WorkflowRun, WorkflowStore } from "../workflows/store.js";
import { def, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const askConfig = testConfig({ permissionMode: "ask" });

function fakeAgent(name: string, type: "native" | "a2a"): AgentDefinition {
  return { manifest: { name, description: name, version: "1.0.0", type, ...(type === "a2a" ? { "a2a-url": "http://localhost:1" } : {}) }, systemPrompt: `I am ${name}`, tools: [], origin: "project", path: `/fake/${name}` } as AgentDefinition;
}
const AGENTS = [fakeAgent("coder", "native"), fakeAgent("remote", "a2a")];

type Reply = string | ((req: AgentInvokeRequest) => Promise<string | AgentInvokeResult> | string | AgentInvokeResult);
/** Mock invoker: records every request; replies are taken in order (the last repeats). */
function mockInvoker(...replies: Reply[]): AgentInvoker & { requests: AgentInvokeRequest[] } {
  const requests: AgentInvokeRequest[] = [];
  return {
    requests,
    async invoke(req) {
      requests.push(req);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)] ?? "ok";
      const out = typeof reply === "function" ? await reply(req) : reply;
      return typeof out === "string" ? { text: out, durationMs: 5, model: "mock-model", usage: { inputTokens: 1, outputTokens: 2 } } : out;
    },
  };
}
function deps(invoker: AgentInvoker): AgentNodeDeps {
  return { getInvoker: () => invoker, loadAgents: async () => AGENTS, decisionPollMs: 10 };
}
/** Background-style run: consent stored on the run, BackgroundHost files inbox decisions. */
async function backgroundRun(definition: WorkflowDefinition, inputs: Record<string, unknown> = {}, tools?: string[]): Promise<WorkflowRun> {
  const run = await createRun(store, definition, inputs, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "ask", []);
  if (tools) run.consent.capabilities.tools = tools;
  await store.lock(run.id, () => store.save(run));
  return run;
}
async function execute(run: WorkflowRun, invoker: AgentInvoker, signal?: AbortSignal): Promise<WorkflowRun> {
  return executeRun(store, run.id, registry, askConfig, signal, createBackgroundHost(run.consent!, { store, runId: run.id }), undefined, deps(invoker));
}
const runPath = (id: string) => join(store.root, `${id}.json`);

describe("agent and prompt node validation", () => {
  const base = (nodes: unknown[]) => ({ version: 1, name: "x", nodes });
  it("accepts agent and prompt nodes with their optional fields", () => {
    expect(() => validateDefinition(base([
      { id: "a", type: "agent", agent: "coder", task: "do", model: "m", effort: "high", maxIterations: 5, timeoutSeconds: 10, retrySafe: false, output: "json", outputSchema: { type: "object" } },
      { id: "p", type: "prompt", prompt: "sum ${nodes.a.output.x}", allowedTools: ["read_file"], dependsOn: ["a"] },
    ]), registry)).not.toThrow();
  });
  it.each([
    ["prompt allowedTools outside WORKFLOW_TOOLS", [{ id: "p", type: "prompt", prompt: "x", allowedTools: ["read_file", "run_background_job"] }], /allowedTools entry "run_background_job" is not a workflow tool/],
    ["outputSchema without output json", [{ id: "a", type: "agent", agent: "coder", task: "t", outputSchema: { type: "object" } }], /outputSchema requires output: "json"/],
    ["outputSchema that does not compile", [{ id: "a", type: "agent", agent: "coder", task: "t", output: "json", outputSchema: { type: "nope" } }], /invalid outputSchema/],
    ["reference to a non-dependency", [{ id: "a", type: "agent", agent: "coder", task: "t" }, { id: "b", type: "agent", agent: "coder", task: "use ${nodes.a.output}" }], /not one of its dependencies/],
    ["reference to an unknown node", [{ id: "b", type: "prompt", prompt: "use ${nodes.zz.output}" }], /unknown node "zz"/],
    ["tool reference to a non-dependency", [{ id: "a", type: "prompt", prompt: "x" }, { id: "w", type: "tool", tool: "write_file", input: { path: "o", content: "${nodes.a.output}" } }], /not one of its dependencies/],
    ["agent node without task", [{ id: "a", type: "agent", agent: "coder" }], /agent and task are required/],
    ["maxIterations above 200", [{ id: "a", type: "agent", agent: "coder", task: "t", maxIterations: 201 }], /Invalid workflow/],
    ["agent fields on a tool node", [{ id: "t", type: "tool", tool: "read_file", input: { path: "x" }, model: "m" }], /only allowed on agent\/prompt nodes/],
  ])("rejects %s", (_label, nodes, error) => {
    expect(() => validateDefinition(base(nodes), registry)).toThrow(error);
  });
  it("accepts an indirect dependency reference", () => {
    expect(() => validateDefinition(base([
      { id: "a", type: "prompt", prompt: "x" }, { id: "b", type: "approval", prompt: "ok?", dependsOn: ["a"] },
      { id: "c", type: "prompt", prompt: "${nodes.a.output} ${nodes.b.status}", dependsOn: ["b"] },
    ]), registry)).not.toThrow();
  });
});

describe("agent and prompt node execution", () => {
  it("native and a2a agent nodes reach the invoker with exactly the interpolated task and no history", async () => {
    const invoker = mockInvoker("native reply", "remote reply");
    const run = await backgroundRun(def([
      { id: "n", type: "agent", agent: "coder", task: "Fix ${inputs.file}" },
      { id: "r", type: "agent", agent: "remote", task: "Review: ${nodes.n.output}", dependsOn: ["n"] },
    ], { inputs: { file: { type: "string" } } }), { file: "a.ts" });
    const done = await execute(run, invoker);
    expect(done.status).toBe("passed");
    expect(invoker.requests).toHaveLength(2);
    const [native, remote] = invoker.requests;
    expect(native!.task).toBe("Fix a.ts");
    expect(native!.agent?.manifest.type).toBe("native");
    expect(remote!.task).toBe("Review: native reply");
    expect(remote!.agent?.manifest.type).toBe("a2a");
    for (const req of invoker.requests) {
      expect(req).not.toHaveProperty("history");
      expect(req).not.toHaveProperty("messages");
      expect(req).not.toHaveProperty("conversation");
      expect(req.cwd).toBe(run.cwd);
    }
    expect(done.nodes[1]).toMatchObject({ status: "passed", output: "remote reply", model: "mock-model", durationMs: 5, usage: { inputTokens: 1, outputTokens: 2 } });
    const transcript = await readFile(join(store.runDir(run.id), "artifacts", "n.txt"), "utf8");
    expect(transcript).toContain("Fix a.ts");
    expect(transcript).toContain("native reply");
    // The checkpoint metadata round-trips through store validation.
    expect((await store.read(run.id, registry)).nodes[0]).toMatchObject({ model: "mock-model", durationMs: 5 });
  });

  it("an unknown agent fails the node clearly", async () => {
    const invoker = mockInvoker("x");
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "ghost", task: "t" }]));
    const done = await execute(run, invoker);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/Unknown agent "ghost"/);
    expect(invoker.requests).toHaveLength(0);
  });

  it("stores valid json output structured and a downstream node interpolates a field", async () => {
    const invoker = mockInvoker('Here:\n```json\n{"field": "value", "n": 2}\n```', "done");
    const run = await backgroundRun(def([
      { id: "a", type: "agent", agent: "coder", task: "analyse", output: "json", outputSchema: { type: "object", required: ["field"], properties: { field: { type: "string" } } } },
      { id: "b", type: "prompt", prompt: "Use ${nodes.a.output.field} (${nodes.a.output.n})", dependsOn: ["a"] },
    ]));
    const done = await execute(run, invoker);
    expect(done.status).toBe("passed");
    expect(done.nodes[0]!.output).toEqual({ field: "value", n: 2 });
    expect(invoker.requests[1]!.task).toBe("Use value (2)");
    expect(invoker.requests[1]!.agent).toBeUndefined();
    expect(invoker.requests[1]!.systemPrompt).toBeTruthy();
  });

  it("a schema-invalid output fails the node", async () => {
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "coder", task: "t", output: "json", outputSchema: { type: "object", required: ["field"] } }]));
    const done = await execute(run, mockInvoker('{"other": 1}'));
    expect(done.status).toBe("failed");
    expect(done.nodes[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/does not match schema/) });
    expect(done.nodes[0]!.output).toBeUndefined();
  });

  it("an a2a agent node with model/effort/maxIterations fails clearly instead of silently ignoring them", async () => {
    const invoker = mockInvoker("x");
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "remote", task: "t", model: "claude-x", maxIterations: 3 }]));
    const done = await execute(run, invoker);
    expect(done.status).toBe("failed");
    expect(done.nodes[0]!.error).toMatch(/"remote" is an a2a agent; model, maxIterations cannot be applied/);
    expect(invoker.requests).toHaveLength(0);
  });

  it("passes model, effort, maxIterations and prompt allowedTools", async () => {
    const invoker = mockInvoker("ok");
    const run = await backgroundRun(def([
      { id: "a", type: "agent", agent: "coder", task: "t", model: "claude-x", effort: "high", maxIterations: 7 },
      { id: "p", type: "prompt", prompt: "p", allowedTools: ["read_file", "grep_search"], model: "small", dependsOn: ["a"] },
    ]));
    await execute(run, invoker);
    expect(invoker.requests[0]).toMatchObject({ model: "claude-x", effort: "high", maxIterations: 7 });
    expect(invoker.requests[1]).toMatchObject({ model: "small", allowedTools: ["read_file", "grep_search"] });
    expect(invoker.requests[1]!.effort).toBeUndefined();
  });

  it("confirmTool: SAFE approved without a decision; tool-node consent does not cover agent sub-tools (agent_tool_consent)", async () => {
    const seen: Array<[string, boolean]> = [];
    const invoker = mockInvoker(async req => {
      seen.push(["read_file", await req.confirmTool("read_file", { path: "x" })]);
      expect(await listPendingDecisions(store, run.id)).toHaveLength(0);
      const pendingEdit = req.confirmTool("edit_file", { path: "x", old_string: "a", new_string: "b" });
      let pending = await listPendingDecisions(store, run.id);
      for (let i = 0; pending.length === 0 && i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 10)); pending = await listPendingDecisions(store, run.id); }
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ kind: "agent_tool_consent", nodeId: "a", resolved: { toolName: "edit_file", input: { path: "x", old_string: "a", new_string: "b" } } });
      await decide(store, run.id, pending[0]!.decisionId, false, "u@h");
      seen.push(["edit_file", await pendingEdit]);
      return "finished";
    });
    // The consent covers edit_file (e.g. used by a tool node); that must not approve an agent's edit_file call.
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "coder", task: "t" }]), {}, ["edit_file"]);
    const done = await execute(run, invoker);
    expect(seen).toEqual([["read_file", true], ["edit_file", false]]);
    // A denied sub-tool call only refuses that call; the agent continues and the node passes.
    expect(done.status).toBe("passed");
    expect(done.nodes[0]!.output).toBe("finished");
  });

  it("refuses a destructive agent run_command without filing a decision, even when run_command is consented", async () => {
    let result: boolean | undefined;
    const destructive = ["rm", "-rf", "/"].join(" ");
    const invoker = mockInvoker(async req => { result = await req.confirmTool("run_command", { command: destructive }); return "done"; });
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "coder", task: "t" }]), {}, ["run_command"]);
    await executeRun(store, run.id, registry, testConfig({ permissionMode: "auto-accept" }), undefined, createBackgroundHost(run.consent!, { store, runId: run.id }), undefined, deps(invoker));
    expect(result).toBe(false);
    expect(await listPendingDecisions(store, run.id)).toHaveLength(0);
  });

  it("timeoutSeconds aborts the invocation and records timed_out", async () => {
    const invoker = mockInvoker(req => new Promise((_resolve, reject) => {
      req.signal.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
    }));
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "coder", task: "slow", timeoutSeconds: 0.05 }]));
    const done = await execute(run, invoker);
    expect(done.nodes[0]).toMatchObject({ status: "timed_out", error: expect.stringMatching(/Timed out/) });
    expect(done.status).toBe("timed_out");
    expect(invoker.requests[0]!.signal.aborted).toBe(true);
  });

  it("status output summarizes agent output without dumping it", async () => {
    const long = "word ".repeat(500);
    const run = await backgroundRun(def([{ id: "a", type: "prompt", prompt: "t" }, { id: "j", type: "prompt", prompt: "u", output: "json", dependsOn: ["a"] }]));
    const done = await execute(run, mockInvoker(long, '{"k":[1,2,3]}'));
    const text = runSummary(done);
    expect(text).toContain("a: passed (mock-model, 0.0s)");
    expect(text).toContain('→ {"k":[1,2,3]}');
    expect(text.length).toBeLessThan(600);
    expect(text).toContain("…");
  });
});

describe("resume of an interrupted agent node", () => {
  async function interrupt(run: WorkflowRun): Promise<void> {
    const raw = JSON.parse(await readFile(runPath(run.id), "utf8")) as WorkflowRun;
    raw.status = "running"; raw.nodes[0] = { id: raw.nodes[0]!.id, status: "running", startedAt: new Date().toISOString() };
    await writeFile(runPath(run.id), JSON.stringify(raw));
  }
  it("re-runs by default (retrySafe defaults to true)", async () => {
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "coder", task: "t" }]));
    await interrupt(run);
    const invoker = mockInvoker("again");
    const done = await execute(run, invoker);
    expect(done.status).toBe("passed");
    expect(invoker.requests).toHaveLength(1);
    expect(await listPendingDecisions(store, run.id)).toHaveLength(0);
  });
  it("retrySafe:false parks on an uncertain decision; approve re-runs, deny would fail", async () => {
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "coder", task: "t", retrySafe: false }]));
    await interrupt(run);
    const invoker = mockInvoker("after approval");
    const parked = await execute(run, invoker);
    expect(parked.status).toBe("waiting_approval");
    expect(invoker.requests).toHaveLength(0);
    const [pending] = await listPendingDecisions(store, run.id);
    expect(pending).toMatchObject({ kind: "uncertain_tool", nodeId: "a" });
    await decide(store, run.id, pending!.decisionId, true, "u@h");
    const done = await execute(run, invoker);
    expect(done.status).toBe("passed");
    expect(invoker.requests).toHaveLength(1);
  });
  it("retrySafe:false denied uncertain decision fails the node", async () => {
    const run = await backgroundRun(def([{ id: "a", type: "agent", agent: "coder", task: "t", retrySafe: false }]));
    await interrupt(run);
    const invoker = mockInvoker("x");
    await execute(run, invoker);
    await decide(store, run.id, (await listPendingDecisions(store, run.id))[0]!.decisionId, false, "u@h");
    const done = await execute(run, invoker);
    expect(done.status).toBe("failed");
    expect(invoker.requests).toHaveLength(0);
  });
});
