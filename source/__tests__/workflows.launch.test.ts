import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { PlatformCapabilities } from "../background-jobs/types.js";
import { assertBackgroundRunsAvailable } from "../workflows/background.js";
import { buildConsent } from "../workflows/grant.js";
import { getNodeEntryLoaderArgs, getWorkflowRunnerArgs, isStandaloneBinary } from "../background-jobs/packaging/manifest.js";
import { launchRun, runnerLaunchSession, runnerStartRequest } from "../workflows/launch.js";
import { reconcileRuns } from "../workflows/reconcile.js";
import { createRun } from "../workflows/runtime.js";
import { runnerRequestId, WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { def, FakeCoordinator, registry, tempStore } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { await cleanup(); });

const definition = def([{ id: "a", type: "job", command: "echo hi" }]);
const CLI = "/opt/agav/build/cli.js";

async function backgroundRun(envNames: string[] = []): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "ask", envNames);
  await store.lock(run.id, () => store.save(run));
  return run;
}

class CapCoordinator extends FakeCoordinator {
  constructor(private readonly nativeHelperAvailable = true, private readonly hostPlatform: PlatformCapabilities["platform"] = "linux") { super(); }
  async capabilities(): Promise<PlatformCapabilities> {
    return { platform: this.hostPlatform, availableIsolationBackends: [], strongestOwnershipScope: "process-group", supportsGracefulApplicationShutdown: true, supportsDelegatedCgroup: false, nativeHelperAvailable: this.nativeHelperAvailable, limitations: this.nativeHelperAvailable ? [] : ["no helper"] } as PlatformCapabilities;
  }
}

describe("launchRun", () => {
  it("starts one supervised runner job with the expected request", async () => {
    const run = await backgroundRun(["OPENAI_API_KEY"]);
    const coordinator = new CapCoordinator();
    const result = await launchRun(store, run.id, { coordinator, cliPath: CLI, admissionEnv: { OPENAI_API_KEY: "x" } });
    expect(result.status).toBe("started");
    expect(coordinator.starts).toHaveLength(1);
    expect(coordinator.starts[0]).toEqual({
      requestId: `wf-run-${run.id}-1`,
      invocation: { mode: "direct", executable: process.execPath, args: [CLI, "--internal-workflow-runner", run.id] },
      cwd: run.cwd, envInherit: ["OPENAI_API_KEY"], isolation: { backend: "none", required: false }, headless: true,
    });
    const saved = await store.read(run.id, registry);
    expect(saved.status).toBe("queued");
    expect(saved.runner).toEqual({ attempt: 1, requestId: `wf-run-${run.id}-1`, jobId: "job-1", relaunches: 0 });
  });

  it("is idempotent: a second launch reattaches and never starts a second runner", async () => {
    const run = await backgroundRun();
    const coordinator = new CapCoordinator();
    await launchRun(store, run.id, { coordinator, cliPath: CLI });
    const again = await launchRun(store, run.id, { coordinator, cliPath: CLI });
    expect(again.status).toBe("attached");
    expect(again.job?.jobId).toBe("job-1");
    expect(coordinator.starts).toHaveLength(1);
  });

  it("refuses when the coordinator reports nativeHelperAvailable:false", async () => {
    const run = await backgroundRun();
    const coordinator = new CapCoordinator(false);
    await expect(launchRun(store, run.id, { coordinator, cliPath: CLI })).rejects.toThrow(/native process helper is missing/);
    expect(coordinator.starts).toHaveLength(0);
    expect((await store.read(run.id, registry)).status).toBe("pending");
  });

  it("allows the Windows fallback and warns without claiming sandbox or Job Object protection", async () => {
    const run = await backgroundRun();
    const coordinator = new CapCoordinator(false, "win32");
    const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(assertBackgroundRunsAvailable(coordinator)).resolves.toBeUndefined();
      expect((await launchRun(store, run.id, { coordinator, cliPath: CLI })).status).toBe("started");
      expect(coordinator.starts[0]?.isolation).toEqual({ backend: "none", required: false });
      const text = warning.mock.calls.map(call => String(call[0])).join("");
      expect(text).toContain("unsandboxed");
      expect(text).toContain("Docker");
      expect(text).toContain("Job Object");
    } finally { warning.mockRestore(); }
  });

  it("refuses a run without consent", async () => {
    const run = await createRun(store, definition, {}, { host: "background" });
    await expect(launchRun(store, run.id, { coordinator: new CapCoordinator(), cliPath: CLI })).rejects.toThrow(/no background consent/);
  });

  it("queues when the workflow-runner pool is full and admits the run once a slot frees", async () => {
    const coordinator = new CapCoordinator();
    const first = await backgroundRun();
    const second = await backgroundRun();
    expect((await launchRun(store, first.id, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 })).status).toBe("started");
    const queued = await launchRun(store, second.id, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 });
    expect(queued.status).toBe("queued");
    expect((await store.read(second.id, registry)).status).toBe("queued");
    expect(coordinator.starts).toHaveLength(1);

    // Still full: reconcile leaves it queued.
    await reconcileRuns(store, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 });
    expect(coordinator.starts).toHaveLength(1);

    // The first runner finishes its run, freeing the slot.
    const firstRun = await store.read(first.id, registry);
    firstRun.status = "passed"; firstRun.nodes[0]!.status = "passed"; firstRun.nodes[0]!.job = { requestId: `wf-${first.id}-a-1`, jobId: "x", state: "completed" };
    await store.lock(first.id, () => store.save(firstRun));
    coordinator.jobs.set("job-1", { ...coordinator.jobs.get("job-1")!, state: "completed", exitCode: 0 });

    const results = await reconcileRuns(store, { coordinator, cliPath: CLI, maxConcurrentWorkflowRuns: 1 });
    expect(results).toContainEqual({ runId: second.id, action: "admitted" });
    expect(coordinator.starts.map(request => request.requestId)).toEqual([`wf-run-${first.id}-1`, `wf-run-${second.id}-1`]);
  });

  it("uses a headless session that approves only the workflow-run launch actions", () => {
    expect(runnerLaunchSession().headlessApprovedActions).toEqual(["workflow-run", "start", "headless-start"]);
  });
});

describe("runner invocation args", () => {
  const BUNFS_URL = "file:///$bunfs/root/cli.js";
  const VIRTUAL_ENTRY = "/$bunfs/root/agav";

  it("getWorkflowRunnerArgs prepends the entry script only when given one", () => {
    expect(getWorkflowRunnerArgs("run1", CLI)).toEqual([CLI, "--internal-workflow-runner", "run1"]);
    expect(getWorkflowRunnerArgs("run1")).toEqual(["--internal-workflow-runner", "run1"]);
  });

  it("recognises the Bun virtual module URL as standalone", () => {
    expect(isStandaloneBinary(BUNFS_URL)).toBe(true);
    expect(isStandaloneBinary("file:///opt/agav/build/cli.js")).toBe(false);
  });

  it("node install: the runner request keeps the entry script before the flag", async () => {
    const run = await backgroundRun();
    run.runner = { attempt: 1, requestId: runnerRequestId(run.id, 1), relaunches: 0 };
    const request = runnerStartRequest(run, CLI, isStandaloneBinary("file:///opt/agav/build/cli.js"));
    expect(request.invocation).toEqual({ mode: "direct", executable: process.execPath, args: [CLI, "--internal-workflow-runner", run.id] });
  });

  it("standalone binary: the virtual entry path is dropped and the binary re-executes itself", async () => {
    const run = await backgroundRun();
    run.runner = { attempt: 1, requestId: runnerRequestId(run.id, 1), relaunches: 0 };
    const request = runnerStartRequest(run, VIRTUAL_ENTRY, isStandaloneBinary(BUNFS_URL));
    expect(request.invocation).toEqual({ mode: "direct", executable: process.execPath, args: ["--internal-workflow-runner", run.id] });
    expect(request.requestId).toBe(`wf-run-${run.id}-1`);
  });

  it("TypeScript source entry: prepends only the resolved tsx loader, never the parent's execArgv", async () => {
    const run = await backgroundRun();
    run.runner = { attempt: 1, requestId: runnerRequestId(run.id, 1), relaunches: 0 };
    const original = process.execArgv;
    process.execArgv = ["--inspect=0", "--require", "/evil.cjs"];
    try {
      const { invocation } = runnerStartRequest(run, "/repo/source/cli.tsx", false);
      if (invocation.mode !== "direct") throw new Error("expected direct invocation");
      expect(invocation.args).toHaveLength(5);
      expect(invocation.args.slice(0, 1)).toEqual(["--import"]);
      expect(invocation.args[1]).toMatch(/^file:\/\/.*tsx/);
      expect(invocation.args.slice(2)).toEqual(["/repo/source/cli.tsx", "--internal-workflow-runner", run.id]);
      expect(invocation.args.join(" ")).not.toMatch(/evil|inspect/);
    } finally { process.execArgv = original; }
  });

  it("compiled entries and standalone binaries get no loader args", () => {
    expect(getNodeEntryLoaderArgs("/opt/agav/build/cli.js")).toEqual([]);
    expect(getNodeEntryLoaderArgs("C:\\agav\\build\\cli.mjs")).toEqual([]);
    expect(getNodeEntryLoaderArgs("/x/cli.tsx", () => "/nm/tsx/dist/loader.mjs")).toEqual(["--import", pathToFileURL("/nm/tsx/dist/loader.mjs").href]);
    expect(() => getNodeEntryLoaderArgs("/x/cli.tsx", () => { throw new Error("nope"); })).toThrow(/tsx loader is not installed/);
  });

  it("the source entry request loads under a real node child (no ERR_UNKNOWN_FILE_EXTENSION)", async () => {
    const run = await backgroundRun();
    run.runner = { attempt: 1, requestId: runnerRequestId(run.id, 1), relaunches: 0 };
    const sourceEntry = fileURLToPath(new URL("../cli.tsx", import.meta.url));
    const { invocation } = runnerStartRequest(run, sourceEntry, false);
    if (invocation.mode !== "direct") throw new Error("expected direct invocation");
    const child = spawnSync(invocation.executable, invocation.args.map(arg => arg === run.id ? "no-such-run-id" : arg), { cwd: run.cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, AGAV_HOME: run.cwd } });
    const output = `${child.stderr}${child.stdout}`;
    expect(output).not.toContain("ERR_UNKNOWN_FILE_EXTENSION");
    expect(output).toContain("workflow runner failed"); // reached cli.tsx's runner branch, not a loader failure
  }, 90_000);
});
