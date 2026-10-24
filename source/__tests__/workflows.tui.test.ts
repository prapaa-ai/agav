import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { WorkflowsTUI } from "../components/workflows-tui.js";
import type { WorkflowResourceDeps } from "../resources/workflow-adapters.js";
import { createPendingDecision, readDecision, listPendingDecisions, resolvedInput } from "../workflows/decisions.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import type { WorkflowStore } from "../workflows/store.js";
import { def, fakeHost, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let coordinator: FakeCoordinator;
let store: WorkflowStore, root: string, cleanup: () => Promise<void>, deps: WorkflowResourceDeps;
beforeEach(async () => {
  ({ store, root, cleanup } = await tempStore());
  coordinator = new FakeCoordinator();
  deps = { store, registry, cwd: join(root, "proj"), userDir: join(root, "user-wf"), config: testConfig(), getCoordinator: async () => coordinator, cliPath: async () => "/x/cli.js" };
});
afterEach(async () => { await cleanup(); });

async function mount(size: { columns: number; rows: number } = { columns: 140, rows: 30 }, reconcileRuns?: (opts: { maxConcurrentWorkflowRuns?: number }) => Promise<void>, height?: number) {
  const onExit = vi.fn();
  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, ...size, write: (text: string) => { output += text; return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const instance = render(h(WorkflowsTUI, { onExit, config: testConfig(), deps, reconcileRuns, height }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => { await new Promise((r) => setTimeout(r, 80)); await instance.waitUntilRenderFlush(); };
  const key = async (text: string) => { output = ""; stdin.emit("data", Buffer.from(text)); await settle(); await settle(); };
  const frame = () => output.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  await settle(); await settle();
  return { instance, key, settle, onExit, frame };
}

describe("WorkflowsTUI", () => {
  it("fires a best-effort reconcile/admission pass once on open without blocking render", async () => {
    const reconcileRuns = vi.fn(() => new Promise<void>(() => {})); // never settles
    const ui = await mount(undefined, reconcileRuns);
    try {
      expect(ui.frame()).toContain("Workflows · List");
      expect(reconcileRuns).toHaveBeenCalledOnce();
      expect(reconcileRuns).toHaveBeenCalledWith({ maxConcurrentWorkflowRuns: testConfig().maxConcurrentWorkflowRuns });
      await ui.key("\t");
      expect(reconcileRuns).toHaveBeenCalledOnce();
    } finally { ui.instance.unmount(); }
  });

  it("switches Workflows → Runs → Inbox with Tab, then approves a decision through the y/n confirmation", async () => {
    const dir = join(deps.cwd, ".agav", "workflows");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "deployer.json"), JSON.stringify(def([{ id: "gate", type: "approval", prompt: "deploy?" }], { name: "deployer" })));
    const run = await createRun(store, def([{ id: "gate", type: "approval", prompt: "deploy?" }], { name: "deployer" }), {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    const [pending] = await listPendingDecisions(store, run.id);
    const ui = await mount();
    try {
      expect(ui.frame()).toContain("Workflows · List");
      expect(ui.frame()).toContain("deployer  [project]");
      expect(ui.frame()).toContain("R: Run");
      expect(ui.frame()).toContain("Inbox (1)");
      await ui.key("\t");
      expect(ui.frame()).toContain("Workflow runs · List");
      expect(ui.frame()).toContain(`◐ ${run.id.slice(0, 8)} deployer`);
      expect(ui.frame()).toContain("a/D: Approve/Deny");
      await ui.key("\t");
      expect(ui.frame()).toContain("Workflow inbox · List");
      expect(ui.frame()).toContain(`◐ gate · deployer ${run.id.slice(0, 8)}`);
      await ui.key("a");
      expect(ui.frame()).toContain("Approve this approval?");
      expect(ui.frame()).toContain("y: Yes, approve · n/ESC: Go back");
      expect(ui.frame()).toContain("deploy?");
      expect((await readDecision(store, run.id, pending!.decisionId))?.decided).toBeUndefined();
      await ui.key("y");
      await ui.settle();
      expect((await readDecision(store, run.id, pending!.decisionId))?.decided?.decision).toBe("approve");
      expect(ui.frame()).toContain("approved");
      await ui.key("\t");
      expect(ui.frame()).toContain("Workflows · List");
      await ui.key("\x1b");
      expect(ui.onExit).toHaveBeenCalledOnce();
    } finally { ui.instance.unmount(); }
  });

  it("n goes back from the deny confirmation without deciding; y then denies", async () => {
    const run = await createRun(store, def([{ id: "gate", type: "approval", prompt: "deploy?" }], { name: "deployer" }), {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    const [pending] = await listPendingDecisions(store, run.id);
    const ui = await mount();
    try {
      await ui.key("\t"); await ui.key("\t");
      await ui.key("D");
      expect(ui.frame()).toContain("Deny this approval?");
      await ui.key("n");
      expect(ui.frame()).toContain("Not decided.");
      expect(ui.frame()).not.toContain("Deny this approval?");
      expect(ui.frame()).toContain("Workflow inbox · List");
      expect((await readDecision(store, run.id, pending!.decisionId))?.decided).toBeUndefined();
      await ui.key("D"); await ui.key("y"); await ui.settle();
      expect((await readDecision(store, run.id, pending!.decisionId))?.decided?.decision).toBe("deny");
    } finally { ui.instance.unmount(); }
  });

  it("shows a short deny confirmation: action question, prompt, workflow and 8-char run id, naming the action in the controls", async () => {
    const run = await createRun(store, def([{ id: "gate", type: "approval", prompt: "Ship it?" }], { name: "m2-approve" }), {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    const ui = await mount({ columns: 80, rows: 24 });
    try {
      await ui.key("\t"); await ui.key("\t");
      await ui.key("D");
      const frame = ui.frame().slice(ui.frame().lastIndexOf("Workflows │"));
      expect(frame).toContain("Deny this approval?");
      expect(frame).toContain("Ship it?");
      expect(frame).toContain(`m2-approve ${run.id.slice(0, 8)}`);
      expect(frame).toContain("This does not grant tool permissions.");
      expect(frame).toContain("y: Yes, deny · n/ESC: Go back");
      expect(frame).not.toContain("Approval grants no tool permissions");
      expect(frame).not.toContain("y: Approve");
      expect(frame).not.toContain("Directory:");
      expect(frame).not.toContain("Permission mode:");
      expect(frame).not.toContain("Decision:");
      expect(frame).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
      expect(frame.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(24);
      // The confirmation itself (title through controls) is compact.
      const confirmation = frame.slice(frame.indexOf("Deny this approval?"), frame.indexOf("y: Yes, deny"));
      expect(confirmation.split("\n").length).toBeLessThanOrEqual(6);
    } finally { ui.instance.unmount(); }
  });

  it("confirms a tool-consent decision with the tool call on one line", async () => {
    const run = await createRun(store, def([{ id: "gate", type: "approval", prompt: "x" }], { name: "tooler" }), {});
    await createPendingDecision(store, run.id, { kind: "tool_consent", nodeId: "build", summary: "Allow bash in node build?", resolved: resolvedInput("bash", { command: "npm test" }) });
    const ui = await mount();
    try {
      await ui.key("\t"); await ui.key("\t");
      await ui.key("D");
      expect(ui.frame()).toContain("Deny this tool call?");
      expect(ui.frame()).toContain("Allow bash in node build?");
      expect(ui.frame()).toContain('Tool call: bash {"command":"npm test"}');
      expect(ui.frame()).not.toContain("This does not grant tool permissions.");
      expect(ui.frame()).toContain("y: Yes, deny · n/ESC: Go back");
    } finally { ui.instance.unmount(); }
  });

  it("x asks 'Cancel this run?' with controls naming the action, and n keeps the run", async () => {
    const run = await createRun(store, def([{ id: "gate", type: "approval", prompt: "deploy?" }], { name: "deployer" }), {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    const ui = await mount();
    try {
      await ui.key("\t");
      await ui.key("x");
      expect(ui.frame()).toContain("Cancel this run?");
      expect(ui.frame()).toContain(`deployer ${run.id.slice(0, 8)}`);
      expect(ui.frame()).toContain("y: Yes, cancel run · n/ESC: Keep running");
      expect(ui.frame()).not.toContain("Deny this");
      await ui.key("n");
      expect(ui.frame()).toContain("Not cancelled.");
      expect((await store.read(run.id, registry)).status).not.toBe("cancelled");
      await ui.key("x"); await ui.key("y"); await ui.settle();
      expect((await store.read(run.id, registry)).status).toBe("cancelled");
    } finally { ui.instance.unmount(); }
  });

  it("R opens the typed input form, then the consent checklist, then launches in the background and shows Runs", async () => {
    const dir = join(deps.cwd, ".agav", "workflows");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "greeter.json"), JSON.stringify(def([{ id: "gate", type: "approval", prompt: "hi ${inputs.who}?" }], { name: "greeter", inputs: { who: { type: "string", required: true } } })));
    const ui = await mount();
    try {
      await ui.key("R");
      expect(ui.frame()).toContain("Run greeter · Inputs");
      await ui.key("\r");
      expect(ui.frame()).toContain("who is required.");
      await ui.key("bob");
      await ui.key("\r");
      expect(ui.frame()).toContain('Run workflow "greeter" in the background?');
      expect(ui.frame()).toContain("y: Approve · n/ESC: Deny");
      await ui.key("y");
      await ui.settle(); await ui.settle();
      expect(coordinator.starts).toHaveLength(1);
      expect(ui.frame()).toContain("Workflow runs · List");
      const [id] = await store.listIds();
      expect((await store.read(id!, registry)).inputs).toEqual({ who: "bob" });
    } finally { ui.instance.unmount(); }
  });

  it("denying consent launches nothing", async () => {
    const dir = join(deps.cwd, ".agav", "workflows");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plain.json"), JSON.stringify(def([{ id: "gate", type: "approval", prompt: "ok?" }], { name: "plain" })));
    const ui = await mount();
    try {
      await ui.key("R");
      expect(ui.frame()).toContain('Run workflow "plain" in the background?');
      await ui.key("n");
      expect(ui.frame()).toContain("Workflow run not approved.");
      expect(coordinator.starts).toHaveLength(0);
      expect(await store.listIds()).toEqual([]);
    } finally { ui.instance.unmount(); }
  });
});

describe("WorkflowsTUI layout", () => {
  it("fits the app-provided overlay height instead of expanding to terminal height", async () => {
    const ui = await mount({ columns: 140, rows: 30 }, undefined, 16);
    try {
      const frame = ui.frame().slice(ui.frame().lastIndexOf("Workflows │"));
      expect(frame.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(16);
      expect(frame).toContain("Workflows · List");
    } finally { ui.instance.unmount(); }
  });

  it("fits the Runs tab, wrapped hints included, in an 80×24 terminal", async () => {
    for (let i = 0; i < 12; i++) {
      const run = await createRun(store, def([{ id: "gate", type: "approval", prompt: "deploy?" }], { name: `deployer-${i}` }), {});
      await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    }
    const ui = await mount({ columns: 80, rows: 24 });
    try {
      await ui.key("\t");
      // The captured output holds every repaint; measure only the last full frame.
      const frame = ui.frame().slice(ui.frame().lastIndexOf("Workflows │ Runs"));
      expect(frame).toContain("Workflow runs · List");
      expect(frame).toContain("a/D: Approve/Deny");
      expect(frame.replaceAll("\n", "")).toContain("ESC: Exit/clear");
      expect(frame).toContain("→ ◐");
      expect(frame.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(24);
    } finally { ui.instance.unmount(); }
  });

  it("says the Inbox has no pending decisions when it is empty", async () => {
    const ui = await mount();
    try {
      await ui.key("\t"); await ui.key("\t");
      expect(ui.frame()).toContain("Workflow inbox · List");
      expect(ui.frame()).toContain("No pending decisions.");
      expect(ui.frame()).not.toContain("No resources found.");
    } finally { ui.instance.unmount(); }
  });
});

describe("/workflows with no arguments", () => {
  it("opens the Workflows TUI interactively and prints usage otherwise; help still prints usage", async () => {
    const { workflowsCommand } = await import("../commands/workflows.js");
    const config = testConfig();
    const interactive = { config, isLoading: false, setPickerActive: vi.fn(), showResourceTUI: vi.fn((_kind: string, done: () => void) => done()) };
    expect(await workflowsCommand.execute("", interactive as never)).toEqual({ type: "none" });
    expect(interactive.showResourceTUI).toHaveBeenCalledWith("workflows", expect.any(Function), false);
    expect(await workflowsCommand.execute("", { config, setPickerActive: vi.fn() } as never)).toMatchObject({ type: "message", text: expect.stringContaining("Usage: /workflows") });
    expect(await workflowsCommand.execute("help", interactive as never)).toMatchObject({ type: "message", text: expect.stringContaining("Usage: /workflows") });
    expect(interactive.showResourceTUI).toHaveBeenCalledOnce();
  });
});
