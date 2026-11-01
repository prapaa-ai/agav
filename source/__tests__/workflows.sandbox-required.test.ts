import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { runWorkflowsCli } from "../cli/workflows-cli.js";
import { admitQueuedRuns } from "../workflows/reconcile.js";
import { runnerRequestId } from "../workflows/store.js";
import { buildConsent } from "../workflows/grant.js";
import { startBackgroundRun } from "../workflows/background.js";
import { launchRun } from "../workflows/launch.js";
import { startRunner } from "../workflows/runner.js";
import { createRun } from "../workflows/runtime.js";
import { WorkflowStore, type WorkflowRun } from "../workflows/store.js";
import { isSandboxRequired, setSandboxRequired } from "../utils/sandbox.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import { WORKFLOW_TOOLS } from "../workflows/definition.js";
import { def, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { setSandboxRequired(false); ({ store, cleanup } = await tempStore()); });
afterEach(async () => { setSandboxRequired(false); await cleanup(); });

const definition = def([{ id: "a", type: "job", command: "echo hi" }]);
const CLI = "/opt/agav/build/cli.js";

async function consented(extra: Partial<WorkflowRun> = {}): Promise<WorkflowRun> {
  const run = await createRun(store, definition, {}, { host: "background" });
  run.consent = buildConsent(definition, run.cwd, "auto-accept", []);
  Object.assign(run, extra);
  await store.lock(run.id, () => store.save(run));
  return run;
}
async function prepared() {
  const created = await createRun(store, definition, {}, { host: "background" });
  return { definition, inputs: {}, cwd: created.cwd, request: {} as never };
}
const run = (id: string, ctx: Partial<Parameters<typeof startRunner>[1]> = {}, coordinator = new FakeCoordinator()) =>
  startRunner(id, { store, registry, config: testConfig(), getCoordinator: async () => coordinator, jobDepsOverrides: { pollIntervalMs: 5 }, ...ctx });

describe("sandboxRequired persistence", () => {
  it("startBackgroundRun persists the parent's effective in-memory requirement", async () => {
    setSandboxRequired(true); // what --sandbox-required does in the parent process
    const result = await startBackgroundRun(store, await prepared(), "auto-accept", [], { coordinator: new FakeCoordinator(), cliPath: CLI, registry });
    expect(result.run.sandboxRequired).toBe(true);
    expect((await store.read(result.run.id, registry)).sandboxRequired).toBe(true);
    expect(JSON.parse(await readFile(`${store.root}/${result.run.id}.json`, "utf8")).sandboxRequired).toBe(true);
  });

  it("does not add the field when nothing requires a sandbox (checkpoint stays backwards compatible)", async () => {
    const result = await startBackgroundRun(store, await prepared(), "auto-accept", [], { coordinator: new FakeCoordinator(), cliPath: CLI, registry });
    expect(Object.hasOwn(JSON.parse(await readFile(`${store.root}/${result.run.id}.json`, "utf8")), "sandboxRequired")).toBe(false);
  });

  it("rejects a non-boolean persisted value", async () => {
    const r = await consented();
    const path = `${store.root}/${r.id}.json`;
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), sandboxRequired: "yes" }));
    await expect(store.read(r.id, registry)).rejects.toThrow(/Invalid workflow checkpoint/);
  });

  it("launchRun can strengthen but never weaken the persisted requirement across relaunches", async () => {
    const r = await consented({ sandboxRequired: true });
    const coordinator = new FakeCoordinator();
    await launchRun(store, r.id, { coordinator, cliPath: CLI, sandboxRequired: false });
    expect((await store.read(r.id, registry)).sandboxRequired).toBe(true);
    const legacy = await consented();
    await launchRun(store, legacy.id, { coordinator, cliPath: CLI, sandboxRequired: true });
    expect((await store.read(legacy.id, registry)).sandboxRequired).toBe(true);
  });
});

describe("sandboxRequired enforcement in the detached runner", () => {
  it("refuses job starts from the persisted requirement when the runner's own config/flags are unset", async () => {
    const coordinator = new FakeCoordinator();
    const r = await consented({ sandboxRequired: true });
    const done = await run(r.id, { sandboxRequired: false }, coordinator).done;
    expect(done.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
    expect(isSandboxRequired()).toBe(true); // run_command in the runner process is enforced too
  });

  it("cannot be weakened by a runner whose config says sandboxRequired=false", async () => {
    const coordinator = new FakeCoordinator();
    const r = await consented({ sandboxRequired: true });
    const done = await run(r.id, { config: testConfig({ sandboxRequired: false }) }, coordinator).done;
    expect(done.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
  });

  it("a stricter runner config still applies to a run without a persisted requirement (legacy checkpoint)", async () => {
    const coordinator = new FakeCoordinator();
    const r = await consented();
    const done = await run(r.id, { config: testConfig({ sandboxRequired: true }) }, coordinator).done;
    expect(done.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
    expect(isSandboxRequired()).toBe(true);
  });

  it("a legacy checkpoint with no requirement anywhere still runs", async () => {
    const coordinator = new FakeCoordinator();
    const r = await consented();
    expect((await run(r.id, {}, coordinator).done).status).toBe("passed");
    expect(coordinator.starts).toHaveLength(1);
    expect(isSandboxRequired()).toBe(false);
  });
});

describe("launchRun isolation", () => {
  it("does not leak the process-wide setting onto another run's checkpoint", async () => {
    setSandboxRequired(true);
    const r = await consented();
    await launchRun(store, r.id, { coordinator: new FakeCoordinator(), cliPath: CLI });
    expect((await store.read(r.id, registry)).sandboxRequired).toBeUndefined();
  });
});

function tty(): PassThrough & { isTTY: boolean } { return Object.assign(new PassThrough(), { isTTY: true }); }

describe("effective sandboxRequired through every launch route (process flag unset)", () => {
  const cli = (argv: string[], config: Partial<Parameters<typeof testConfig>[0]>, coordinator: FakeCoordinator) =>
    runWorkflowsCli(argv, { config: testConfig(config), store, getCoordinator: async () => coordinator, cliPath: CLI, stdout: Object.assign(new PassThrough(), { isTTY: false }) });

  it("initial `workflows run` persists the config requirement on the run and the launch", async () => {
    const { mkdtemp, writeFile: write, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/agav-wf-sr-`);
    try {
      await write(`${dir}/wf.json`, JSON.stringify(definition));
      const stdin = tty(), stdout = tty();
      stdin.end("y\n");
      stdout.resume();
      expect(isSandboxRequired()).toBe(false);
      const code = await runWorkflowsCli(["run", `${dir}/wf.json`], { config: testConfig({ sandboxRequired: true }), store, stdin, stdout, env: {}, getCoordinator: async () => new FakeCoordinator(), cliPath: CLI });
      expect(code).toBe(0);
      const [id] = await store.listIds();
      expect((await store.read(id!, registry)).sandboxRequired).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("initial run without config or flag leaves the checkpoint without the field", async () => {
    const result = await startBackgroundRun(store, await prepared(), "auto-accept", [], { coordinator: new FakeCoordinator(), cliPath: CLI, registry, sandboxRequired: false });
    expect(result.run.sandboxRequired).toBeUndefined();
  });

  it("`resume` uses the effective config (what --sandbox-required sets) for a fresh relaunch", async () => {
    const r = await consented();
    const coordinator = new FakeCoordinator();
    expect(await cli(["resume", r.id], { sandboxRequired: true }, coordinator)).toBe(0);
    expect(coordinator.starts).toHaveLength(1);
    expect((await store.read(r.id, registry)).sandboxRequired).toBe(true);
  });

  it("`resume` of a run whose runner is still attached persists the stricter requirement for later relaunches", async () => {
    const attached = await consented();
    await updateAttempt(attached.id);
    const coordinator = new FakeCoordinator();
    coordinator.jobs.set("j", { jobId: "j", requestId: runnerRequestId(attached.id, 1), state: "running", stopState: "none" });
    expect(await cli(["resume", attached.id], { sandboxRequired: true }, coordinator)).toBe(0);
    expect(coordinator.starts).toHaveLength(0);
    expect((await store.read(attached.id, registry)).sandboxRequired).toBe(true);
  });

  it("`resume` without config or flag does not add a requirement, even if another run is strict", async () => {
    const r = await consented();
    expect(await cli(["resume", r.id], {}, new FakeCoordinator())).toBe(0);
    expect((await store.read(r.id, registry)).sandboxRequired).toBeUndefined();
  });

  it("reconcile (`status`) relaunches a dead runner under the effective config requirement", async () => {
    const r = await consented({ status: "queued" });
    await updateAttempt(r.id, "queued");
    const coordinator = new FakeCoordinator();
    expect(await cli(["status", r.id], { sandboxRequired: true }, coordinator)).toBe(0);
    expect(coordinator.starts).toHaveLength(1);
    expect((await store.read(r.id, registry)).sandboxRequired).toBe(true);
  });

  it("a runner admitting another run never leaks its own requirement onto it", async () => {
    const strict = await consented({ sandboxRequired: true });
    const other = await consented();
    await updateAttempt(other.id, "queued");
    const coordinator = new FakeCoordinator();
    setSandboxRequired(true); // this process (the exiting runner) is strict
    await admitQueuedRuns(store, { coordinator, cliPath: CLI, registry, exitingRunId: strict.id });
    expect(coordinator.starts).toHaveLength(1);
    expect((await store.read(other.id, registry)).sandboxRequired).toBeUndefined();
  });

  it("approve relaunches a parked run under the CLI's effective config requirement", async () => {
    const gated = def([{ id: "gate", type: "approval", prompt: "?" }, { id: "j", type: "job", command: "echo hi", dependsOn: ["gate"] }]);
    const created = await createRun(store, gated, {}, { host: "background" });
    created.consent = buildConsent(gated, created.cwd, "ask", []);
    await store.lock(created.id, () => store.save(created));
    const coordinator = new FakeCoordinator();
    await launchRun(store, created.id, { coordinator, cliPath: CLI });
    const parked = await run(created.id, { config: testConfig({ permissionMode: "ask" }) }, coordinator).done;
    expect(parked.status).toBe("waiting_approval");
    expect(parked.sandboxRequired).toBeUndefined();
    coordinator.jobs.set("j", { jobId: "j", requestId: runnerRequestId(created.id, 1), state: "completed", stopState: "none" });
    coordinator.jobs.set("job-1", { jobId: "job-1", requestId: runnerRequestId(created.id, 1), state: "completed", stopState: "none" });
    expect(await cli(["approve", created.id, "gate"], { sandboxRequired: true }, coordinator)).toBe(0);
    expect(coordinator.starts.map(request => request.requestId)).toEqual([runnerRequestId(created.id, 1), runnerRequestId(created.id, 2)]);
    expect((await store.read(created.id, registry)).sandboxRequired).toBe(true);
  });
});

async function updateAttempt(id: string, status?: WorkflowRun["status"]): Promise<void> {
  const { updateRun } = await import("../workflows/launch.js");
  await updateRun(store, id, registry, current => { current.runner = { attempt: 1, requestId: runnerRequestId(id, 1), relaunches: 0 }; if (status) current.status = status; });
}

describe("run_command enforcement in the detached runner (tool nodes, not only job nodes)", () => {
  // The shared `registry` snapshots AGAV_NO_SANDBOX at import time, so `sandbox: "none"` is only a valid
  // input when the host happens to export it. Build a registry under an explicit env instead.
  let toolRegistry: typeof registry;
  beforeAll(() => {
    vi.stubEnv("AGAV_NO_SANDBOX", "1");
    toolRegistry = createBuiltinToolRegistry(WORKFLOW_TOOLS);
    vi.unstubAllEnvs();
  });
  afterAll(() => { vi.unstubAllEnvs(); });
  const toolDef = def([{ id: "sh", type: "tool", tool: "run_command", input: { command: "echo hi", sandbox: "none" } }]);
  async function toolRun(extra: Partial<WorkflowRun> = {}): Promise<WorkflowRun> {
    const created = await createRun(store, toolDef, {}, { host: "background" });
    created.consent = buildConsent(toolDef, created.cwd, "auto-accept", ["run_command"]);
    Object.assign(created, extra);
    await store.lock(created.id, () => store.save(created));
    return created;
  }

  it("a persisted requirement refuses the command although the runner's own config/flag is unset", async () => {
    const r = await toolRun({ sandboxRequired: true });
    expect(isSandboxRequired()).toBe(false);
    const done = await run(r.id, { registry: toolRegistry }).done;
    expect(done.status).toBe("failed");
    expect(JSON.stringify(done.nodes)).toMatch(/Sandbox required/);
  });

  it("the runner's strict disk config refuses it for a run without a persisted requirement", async () => {
    const r = await toolRun();
    const done = await run(r.id, { registry: toolRegistry, config: testConfig({ sandboxRequired: true }) }).done;
    expect(done.status).toBe("failed");
    expect(JSON.stringify(done.nodes)).toMatch(/Sandbox required/);
    expect((await store.read(r.id, toolRegistry)).sandboxRequired).toBe(true);
  });
});

describe("persistence failure fails closed", () => {
  const diskFull = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

  async function attached() {
    const r = await consented();
    await updateAttempt(r.id);
    const coordinator = new FakeCoordinator();
    coordinator.jobs.set("j", { jobId: "j", requestId: runnerRequestId(r.id, 1), state: "running", stopState: "none" });
    return { r, coordinator };
  }

  it("launchRun attaching to a live runner rejects when the stricter requirement cannot be written", async () => {
    const { r, coordinator } = await attached();
    const save = vi.spyOn(store, "save").mockRejectedValue(diskFull());
    await expect(launchRun(store, r.id, { coordinator, cliPath: CLI, sandboxRequired: true })).rejects.toThrow(/ENOSPC/);
    save.mockRestore();
    expect(coordinator.starts).toHaveLength(0);
    expect((await store.read(r.id, registry)).sandboxRequired).toBeUndefined();
  });

  it("launchRun attaching to a live runner rejects when the run lock cannot be taken", async () => {
    const { r, coordinator } = await attached();
    const lock = vi.spyOn(store, "lock").mockRejectedValue(new Error("lock held"));
    await expect(launchRun(store, r.id, { coordinator, cliPath: CLI, sandboxRequired: true })).rejects.toThrow(/lock held/);
    lock.mockRestore();
    expect(coordinator.starts).toHaveLength(0);
    expect((await store.read(r.id, registry)).sandboxRequired).toBeUndefined();
  });

  it("an already-strict run attaches without any write, so a failing disk is irrelevant", async () => {
    const r = await consented({ sandboxRequired: true });
    await updateAttempt(r.id);
    const coordinator = new FakeCoordinator();
    coordinator.jobs.set("j", { jobId: "j", requestId: runnerRequestId(r.id, 1), state: "running", stopState: "none" });
    const save = vi.spyOn(store, "save").mockRejectedValue(diskFull());
    const lock = vi.spyOn(store, "lock").mockRejectedValue(new Error("lock held"));
    expect((await launchRun(store, r.id, { coordinator, cliPath: CLI, sandboxRequired: true })).status).toBe("attached");
    expect(save).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it("a caller that requires nothing attaches without writing even when the disk fails", async () => {
    const { r, coordinator } = await attached();
    const save = vi.spyOn(store, "save").mockRejectedValue(diskFull());
    expect((await launchRun(store, r.id, { coordinator, cliPath: CLI })).status).toBe("attached");
    expect(save).not.toHaveBeenCalled();
  });

  it("the runner starts no job when its stricter requirement cannot be persisted (disk write failure)", async () => {
    const coordinator = new FakeCoordinator();
    const r = await consented();
    const save = vi.spyOn(store, "save").mockRejectedValue(diskFull());
    await expect(run(r.id, { sandboxRequired: true }, coordinator).done).rejects.toThrow(/ENOSPC/);
    save.mockRestore();
    expect(coordinator.starts).toHaveLength(0);
    const after = await store.read(r.id, registry);
    expect(after.sandboxRequired).toBeUndefined();
    expect(after.status).toBe("pending");
  });

  it("the runner starts no job when the run lock cannot be taken to persist the requirement", async () => {
    const coordinator = new FakeCoordinator();
    const r = await consented();
    const realLock = store.lock.bind(store);
    let calls = 0;
    const lock = vi.spyOn(store, "lock").mockImplementation((id, fn) => ++calls === 1 ? Promise.reject(new Error("lock held")) : realLock(id, fn));
    await expect(run(r.id, { config: testConfig({ sandboxRequired: true }) }, coordinator).done).rejects.toThrow(/lock held/);
    lock.mockRestore();
    expect(coordinator.starts).toHaveLength(0);
    expect((await store.read(r.id, registry)).sandboxRequired).toBeUndefined();
  });

  it("the runner with an already-persisted requirement needs no write and still enforces it", async () => {
    const coordinator = new FakeCoordinator();
    const r = await consented({ sandboxRequired: true });
    const done = await run(r.id, {}, coordinator).done;
    expect(done.status).toBe("failed");
    expect(coordinator.starts).toHaveLength(0);
  });
});
