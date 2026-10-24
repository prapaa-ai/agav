import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflowsCli } from "../cli/workflows-cli.js";
import { consentEnvNames, parseEnvSelection, promptWorkflowConsent, type ConsentRequest } from "../workflows/consent-prompt.js";
import { buildConsent } from "../workflows/grant.js";
import { createRun } from "../workflows/runtime.js";
import { listRuns } from "../workflows/background.js";
import { WorkflowStore } from "../workflows/store.js";
import { def, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { vi.restoreAllMocks(); await cleanup(); });

const definition = def([{ id: "a", type: "job", command: "echo hi" }]);

/** Collects writes; `isTTY` is configurable per test. */
function sink(isTTY: boolean): PassThrough & { isTTY: boolean; text: () => string } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; text: () => string };
  let text = "";
  stream.on("data", chunk => { text += String(chunk); });
  stream.isTTY = isTTY;
  stream.text = () => text;
  return stream;
}

function captureStderr(): () => string {
  let text = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { text += String(chunk); return true; });
  return () => text;
}

describe("agav workflows run", () => {
  it("refuses without a TTY (exit 1) and never creates a run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-wf-cli-"));
    try {
      const file = join(dir, "wf.json");
      await writeFile(file, JSON.stringify(definition));
      const stderr = captureStderr();
      const stdin = Object.assign(new PassThrough(), { isTTY: false });
      const coordinator = new FakeCoordinator();
      const code = await runWorkflowsCli(["run", file], { config: testConfig(), store, stdin, stdout: sink(false), getCoordinator: async () => coordinator, cliPath: "/x/cli.js" });
      expect(code).toBe(1);
      expect(stderr()).toContain("workflow run requires interactive consent");
      expect(await store.listIds()).toEqual([]);
      expect(coordinator.starts).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses when only stdin is a TTY", async () => {
    const stderr = captureStderr();
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const code = await runWorkflowsCli(["run", "missing.json"], { config: testConfig(), store, stdin, stdout: sink(false), getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" });
    expect(code).toBe(1);
    expect(stderr()).toContain("workflow run requires interactive consent");
  });

  it("with consent, creates a background run whose consent records only the selected env names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-wf-cli-"));
    try {
      await mkdir(join(dir, "w"), { recursive: true });
      const file = join(dir, "w", "wf.json");
      await writeFile(file, JSON.stringify(definition));
      const stdin = Object.assign(new PassThrough(), { isTTY: true });
      const stdout = sink(true);
      stdin.end("2\ny\n");
      const coordinator = new FakeCoordinator();
      const code = await runWorkflowsCli(["run", file], { config: testConfig({ permissionMode: "ask", maxConcurrentWorkflowRuns: 2 }), store, stdin, stdout, env: { AAA: "secret-a", BBB: "secret-b", "bad-name": "x" }, getCoordinator: async () => coordinator, cliPath: "/x/cli.js" });
      expect(code).toBe(0);
      const [id] = await store.listIds();
      const run = await store.read(id!, registry);
      expect(run.host).toBe("background");
      expect(run.consent?.envNames).toEqual(["BBB"]);
      expect(run.consent?.capabilities.jobCommands).toEqual(["echo hi"]);
      expect(JSON.stringify(run)).not.toContain("secret-b");
      expect(coordinator.starts).toHaveLength(1);
      expect(coordinator.starts[0]!.envInherit).toEqual(["BBB"]);
      expect(stdout.text()).toContain("echo hi");
      expect(stdout.text()).toMatch(new RegExp(`Workflow run ${id} \\(test\\) started`));
      expect(stdout.text()).toContain(`agav workflows cancel ${id!.slice(0, 8)}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("promptWorkflowConsent", () => {
  const request: ConsentRequest = { workflowName: "wf", cwd: "/work", permissionMode: "ask", capabilities: { tools: ["write_file"], jobCommands: ["npm test"] }, envNames: ["HOME", "OPENAI_API_KEY", "PATH"] };

  it("returns only the selected names, never values", async () => {
    const input = new PassThrough(); const output = sink(true);
    input.end("1,3\ny\n");
    const names = await promptWorkflowConsent(request, input, output);
    expect(names).toEqual(["HOME", "PATH"]);
    expect(output.text()).toContain("write_file");
    expect(output.text()).toContain("$ npm test");
    expect(output.text()).toContain("Permission mode: ask");
  });

  it("re-asks after an invalid selection and denies on anything but y", async () => {
    const input = new PassThrough(); const output = sink(true);
    input.end("9\nall\nn\n");
    expect(await promptWorkflowConsent(request, input, output)).toBeUndefined();
    expect(output.text()).toContain("out of range");
  });

  it("denies on end of input", async () => {
    const input = new PassThrough();
    input.end("");
    expect(await promptWorkflowConsent(request, input, sink(true))).toBeUndefined();
  });
});

describe("parseEnvSelection", () => {
  const names = ["A", "B", "C", "D"];
  it("parses all, none and empty", () => {
    expect(parseEnvSelection("all", names)).toEqual(names);
    expect(parseEnvSelection(" NONE ", names)).toEqual([]);
    expect(parseEnvSelection("", names)).toEqual([]);
  });
  it("parses numbers, commas and ranges into ordered unique names", () => {
    expect(parseEnvSelection("3 1,1", names)).toEqual(["A", "C"]);
    expect(parseEnvSelection("2-4", names)).toEqual(["B", "C", "D"]);
  });
  it("rejects invalid or out-of-range input", () => {
    expect(() => parseEnvSelection("0", names)).toThrow(/out of range/);
    expect(() => parseEnvSelection("5", names)).toThrow(/out of range/);
    expect(() => parseEnvSelection("a", names)).toThrow(/Invalid selection/);
  });
  it("consentEnvNames keeps only valid names, sorted", () => {
    expect(consentEnvNames({ Z: "1", A: "2", "x-y": "3" })).toEqual(["A", "Z"]);
  });
});

describe("agav workflows list", () => {
  it("lists newest first after reconciling", async () => {
    const first = await createRun(store, definition, {});
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await createRun(store, definition, {});
    await new Promise(resolve => setTimeout(resolve, 5));
    const third = await createRun(store, definition, {});
    expect((await listRuns(store, registry)).map(run => run.id)).toEqual([third.id, second.id, first.id]);
    const stdout = sink(false);
    const code = await runWorkflowsCli(["list"], { config: testConfig(), store, stdout, getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" });
    expect(code).toBe(0);
    const lines = stdout.text().trim().split("\n");
    expect(lines.map(line => line.split(/\s+/)[1])).toEqual([third, second, first].map(run => run.id.slice(0, 8)));
    expect(lines[0]).toMatch(/^… [a-f0-9]{8} {2}test {2}pending {2}started \S+ ago$/);
    expect(stdout.text()).not.toContain("{");
  });

  it("list --json keeps the script-friendly shape", async () => {
    const run = await createRun(store, definition, {});
    const stdout = sink(false);
    expect(await runWorkflowsCli(["list", "--json"], { config: testConfig(), store, stdout, getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" })).toBe(0);
    const parsed = JSON.parse(stdout.text()) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]!).sort()).toEqual(["createdAt", "id", "status", "updatedAt", "workflow"]);
    expect(parsed[0]).toMatchObject({ id: run.id, status: "pending", workflow: "test" });
  });

  it("status prints a tree by default, the full checkpoint with --json, and accepts a short id", async () => {
    const run = await createRun(store, definition, {});
    const tree = sink(false);
    expect(await runWorkflowsCli(["status", run.id.slice(0, 6)], { config: testConfig(), store, stdout: tree, getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" })).toBe(0);
    expect(tree.text()).toContain(`Workflow run ${run.id} (test): … pending`);
    expect(tree.text()).toContain("  … a: pending");
    expect(tree.text()).not.toContain("{");
    const json = sink(false);
    expect(await runWorkflowsCli(["status", run.id, "--json"], { config: testConfig(), store, stdout: json, getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" })).toBe(0);
    expect(JSON.parse(json.text())).toMatchObject({ id: run.id, status: "pending", nodes: [{ id: "a", status: "pending" }] });
  });

  it("rejects a too-short run id prefix", async () => {
    const stderr = captureStderr();
    const run = await createRun(store, definition, {});
    expect(await runWorkflowsCli(["status", run.id.slice(0, 3)], { config: testConfig(), store, stdout: sink(false), getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" })).toBe(1);
    expect(stderr()).toContain("too short");
  });

  it("inbox --json keeps the pending decision records", async () => {
    const stdout = sink(false);
    expect(await runWorkflowsCli(["inbox", "--json"], { config: testConfig(), store, stdout, getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" })).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual([]);
    const text = sink(false);
    expect(await runWorkflowsCli(["inbox"], { config: testConfig(), store, stdout: text, getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" })).toBe(0);
    expect(text.text()).toBe("No pending workflow decisions.\n");
  });

  it("status reconciles a queued run (admits it)", async () => {
    const run = await createRun(store, definition, {}, { host: "background" });
    run.consent = buildConsent(definition, run.cwd, "ask", []);
    run.status = "queued";
    run.runner = { attempt: 1, requestId: `wf-run-${run.id}-1`, relaunches: 0 };
    await store.lock(run.id, () => store.save(run));
    const coordinator = new FakeCoordinator();
    const stdout = sink(false);
    expect(await runWorkflowsCli(["status", run.id], { config: testConfig(), store, stdout, getCoordinator: async () => coordinator, cliPath: "/x/cli.js" })).toBe(0);
    expect(coordinator.starts).toHaveLength(1);
    expect(stdout.text()).toContain(`Workflow run ${run.id}`);
  });

  it("cancel stops a live runner via the run's consent", async () => {
    const run = await createRun(store, definition, {}, { host: "background" });
    run.consent = buildConsent(definition, run.cwd, "ask", []);
    await store.lock(run.id, () => store.save(run));
    const coordinator = new FakeCoordinator();
    const { launchRun } = await import("../workflows/launch.js");
    await launchRun(store, run.id, { coordinator, cliPath: "/x/cli.js", registry });
    const stdout = sink(false);
    expect(await runWorkflowsCli(["cancel", run.id.slice(0, 8)], { config: testConfig(), store, stdout, getCoordinator: async () => coordinator, cliPath: "/x/cli.js" })).toBe(0);
    expect(coordinator.stops).toEqual(["job-1"]);
    expect(stdout.text()).toContain("cancelled");
  });
});
