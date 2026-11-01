import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createInboxAdapter, createRunsAdapter, createWorkflowsAdapter, decideWorkflowDecision, deleteWorkflowRun, formatRunLogs,
  inputFields, parseInputValues, parseInboxItemId, updateDefinitionFields, validateWorkflow, workflowActivity, workflowBadge,
  type WorkflowResourceDeps,
} from "../resources/workflow-adapters.js";
import { appendEvent } from "../workflows/events.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { createPendingDecision, readDecision, resolvedInput } from "../workflows/decisions.js";
import { WorkflowStore } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, root: string, cleanup: () => Promise<void>, deps: WorkflowResourceDeps;
beforeEach(async () => {
  ({ store, root, cleanup } = await tempStore());
  const coordinator = new FakeCoordinator();
  deps = { store, registry, cwd: join(root, "proj"), userDir: join(root, "user-wf"), config: testConfig(), getCoordinator: async () => coordinator, cliPath: async () => "/x/cli.js" };
});
afterEach(async () => { await cleanup(); });

const loopDef = {
  version: 1, name: "fixer", description: "Fix until green",
  inputs: { issue: { type: "string", required: true, description: "ticket" }, retries: { type: "number", default: 2 } },
  nodes: [
    { id: "plan", type: "approval", prompt: "plan ok?" },
    { id: "fix", type: "loop", maxIterations: 3, dependsOn: ["plan"], until: "nodes.check.status == 'passed'", body: [{ id: "check", type: "job", command: "npm test" }] },
  ],
};

async function writeWorkflow(dir: string, file: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, content);
  return path;
}

describe("WorkflowsAdapter", () => {
  it("lists project and user definitions; detail shows description, inputs, nodes incl. loops and the source path", async () => {
    const path = await writeWorkflow(join(deps.cwd, ".agav", "workflows"), "fixer.json", JSON.stringify(loopDef));
    await writeWorkflow(deps.userDir!, "broken.yaml", "version: 1\nname: broken\nnodes: nope\n");
    const adapter = createWorkflowsAdapter(deps);
    const items = await adapter.list();
    expect(items.map(i => i.title)).toEqual(["broken  [user] (invalid)", "fixer  [project]"]);
    expect(items[1]!.description).toContain("Fix until green · 3 nodes");
    const detail = (await adapter.get("fixer"))!.detail;
    expect(detail).toContain(`Source: ${path}`);
    expect(detail).toContain("Fix until green");
    expect(detail).toContain("issue (string, required) — ticket");
    expect(detail).toContain("retries (number, default 2)");
    expect(detail).toContain("fix  loop max 3 until nodes.check.status == 'passed' ← plan");
    expect(detail).toContain("    check  job $ npm test");
    expect(await adapter.get("missing")).toBeUndefined();
    expect(await validateWorkflow(deps, "fixer")).toContain("valid");
    await expect(validateWorkflow(deps, "broken")).rejects.toThrow(/Invalid workflow/);
  });

  it("edits only name/description/inputs, validates first and preserves YAML comments", async () => {
    const path = await writeWorkflow(deps.userDir!, "y.yaml", "# keep me\nversion: 1\nname: y\nnodes:\n  - id: a # node\n    type: approval\n    prompt: ok?\n");
    await updateDefinitionFields(path, { name: "renamed", description: "Desc", inputs: '{"n":{"type":"number"}}' }, registry);
    const text = await readFile(path, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("# node");
    expect(text).toContain("name: renamed");
    expect(text).toContain("description: Desc");
    await expect(updateDefinitionFields(path, { name: "x", inputs: '{"n":{"type":"nope"}}' }, registry)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(text);
    const json = await writeWorkflow(deps.userDir!, "j.json", JSON.stringify(loopDef));
    await createWorkflowsAdapter(deps).update!("j", { name: "fixer", description: "", inputs: "" });
    const saved = JSON.parse(await readFile(json, "utf8"));
    expect(saved.description).toBeUndefined();
    expect(saved.inputs).toBeUndefined();
    expect(saved.nodes).toHaveLength(2);
  });

  it("builds typed input fields and parses form values", () => {
    const definition = loopDef as never;
    expect(inputFields(definition).map(f => [f.name, f.required])).toEqual([["issue", true], ["retries", false]]);
    expect(parseInputValues(definition, { issue: "ENG-1", retries: "" })).toEqual({ issue: "ENG-1" });
    expect(parseInputValues(definition, { issue: "x", retries: "4" })).toEqual({ issue: "x", retries: 4 });
    expect(() => parseInputValues(definition, { retries: "4" })).toThrow("issue is required.");
    expect(() => parseInputValues(definition, { issue: "x", retries: "four" })).toThrow("retries must be a number.");
  });
});

describe("RunsAdapter and InboxAdapter", () => {
  const gated = def([{ id: "gate", type: "approval", prompt: "deploy?" }], { name: "deployer" });

  it("lists runs newest first with glyph titles; detail has the tree, pending decisions and the last 10 events", async () => {
    const older = await createRun(store, def([{ id: "a", type: "approval", prompt: "?" }], { name: "older" }), {});
    await new Promise(r => setTimeout(r, 5));
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    for (let i = 0; i < 12; i++) await appendEvent(store, run.id, { type: "node_started", nodeId: `n${i}` });
    const adapter = createRunsAdapter(deps);
    const items = await adapter.list();
    expect(items.map(i => i.id)).toEqual([run.id, older.id]);
    expect(items[0]!.title).toBe(`◐ ${run.id.slice(0, 8)} deployer`);
    expect(items[0]!.description).toContain("◐ waiting: gate");
    expect(items[0]!.values?.decisionId).toMatch(/^dec_/);
    expect(items[0]!.removable).toBe(false);
    const detail = (await adapter.get(run.id))!.detail;
    expect(detail).toContain(`Workflow run ${run.id} (deployer): ◐ waiting_approval`);
    expect(detail).toContain("last events:");
    expect(detail).toContain("node_started n11");
    expect(detail).not.toContain("node_started n1\n");
    expect(detail.split("\n").filter(l => l.includes("node_started")).length).toBe(10);
    expect(await formatRunLogs(store, registry, run.id)).toMatch(/── events \((\d+) of \1\) ──\n[\s\S]*node_started n11/);
  });

  it("inbox shows the full resolved input and approve decides the decision", async () => {
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    const inbox = createInboxAdapter(deps);
    const [entry] = await inbox.list();
    expect(entry!.title).toBe(`◐ gate · deployer ${run.id.slice(0, 8)}`);
    const detail = (await inbox.get(entry!.id))!.detail;
    expect(detail).toContain("approval on gate");
    expect(detail).toContain("deploy?");
    expect(detail).toContain("Approval grants no tool permissions.");
    const { runId, decisionId } = parseInboxItemId(entry!.id);
    expect(await workflowActivity(store)).toEqual({ running: 0, needApproval: 1 });
    expect(workflowBadge({ running: 2, needApproval: 1 })).toBe("workflows: 2 running · 1 need approval");
    expect(workflowBadge({ running: 0, needApproval: 0 })).toBeUndefined();
    expect(await decideWorkflowDecision(deps, runId, decisionId, true)).toContain("approved");
    expect((await readDecision(store, runId, decisionId))?.decided?.decision).toBe("approve");
    expect(await inbox.list()).toEqual([]);
  });

  it("inbox detail shows a resolved tool input in full", async () => {
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    await createPendingDecision(store, run.id, { kind: "tool_consent", nodeId: "gate", summary: "write a file", resolved: resolvedInput("write_file", { path: "out.txt", content: "line1\nline2" }) });
    const items = await createInboxAdapter(deps).list();
    const item = items.find(i => i.description.startsWith("tool consent"))!;
    const detail = (await createInboxAdapter(deps).get(item.id))!.detail;
    expect(detail).toContain("Tool: write_file");
    expect(detail).toContain('"content": "line1\\nline2"');
    expect(detail).toContain("Approving allows identical calls (same tool and resolved input) of this node for the rest of the run.");
  });

  it("deletes only settled runs, removing the checkpoint and run directory", async () => {
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    await expect(deleteWorkflowRun(store, registry, run.id)).rejects.toThrow(/cancel it before deleting/);
    const done = await createRun(store, def([{ id: "t", type: "tool", tool: "read_file", input: { path: "x" } }]), {});
    await executeRun(store, done.id, registry, testConfig(), undefined, fakeHost());
    await appendEvent(store, done.id, { type: "run_status", status: "passed" });
    await createRunsAdapter(deps).remove!(done.id);
    await expect(stat(join(store.root, `${done.id}.json`))).rejects.toThrow();
    await expect(stat(store.runDir(done.id))).rejects.toThrow();
    expect((await createRunsAdapter(deps).list()).map(i => i.id)).toEqual([run.id]);
  });
});
