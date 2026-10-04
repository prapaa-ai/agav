import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStopRequest,
  formatWorkflowJob,
  isStopRequested,
  isWorkflowJobAlive,
  listOrphanedWorkflowJobs,
  listWorkflowJobs,
  markWorkflowJobFinished,
  pruneWorkflowJobs,
  readWorkflowJob,
  requestStop,
  watchForStopRequest,
  type WorkflowJobRecord,
} from "../workflows/jobs.js";

/**
 * The registry is exercised through its persisted form rather than by launching
 * real children. A detached child holds its working directory open, so spawning
 * one per test makes directory cleanup racy on Windows and tests the OS rather
 * than this module.
 */
async function writeJob(dir: string, record: Partial<WorkflowJobRecord> & { id: string }): Promise<void> {
  const jobsDir = join(dir, "jobs");
  await writeFile(
    join(jobsDir, `${record.id}.json`),
    JSON.stringify({
      runId: "run_x",
      target: "wf.yaml",
      status: "running",
      startedAt: new Date().toISOString(),
      ...record,
    }),
    "utf8",
  );
}

describe("workflow job registry", () => {
  let dir: string;
  let previousJobDir: string | undefined;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-wf-jobs-"));
    await writeFile(join(dir, ".keep"), "");
    previousJobDir = process.env["AGAV_WORKFLOW_JOB_DIR"];
    previousConfigDir = process.env["AGAV_CONFIG_DIR"];
    process.env["AGAV_WORKFLOW_JOB_DIR"] = join(dir, "jobs");
    process.env["AGAV_CONFIG_DIR"] = join(dir, "agav");
    // Seed the directory so the first write does not race mkdir.
    await requestStop("run_bootstrap");
    clearStopRequest("run_bootstrap");
  });

  afterEach(async () => {
    for (const runId of ["run_a", "run_b", "run_old", "run_watch1", "run_watch2", "run_watch3"]) {
      clearStopRequest(runId);
    }
    if (previousJobDir === undefined) delete process.env["AGAV_WORKFLOW_JOB_DIR"];
    else process.env["AGAV_WORKFLOW_JOB_DIR"] = previousJobDir;
    if (previousConfigDir === undefined) delete process.env["AGAV_CONFIG_DIR"];
    else process.env["AGAV_CONFIG_DIR"] = previousConfigDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("reports no jobs before anything is written", async () => {
    expect(await listWorkflowJobs()).toEqual([]);
    expect(await readWorkflowJob("missing")).toBeNull();
  });

  it("reads back a persisted job", async () => {
    await writeJob(dir, { id: "aaaa1111", runId: "run_a", pid: process.pid });
    const record = await readWorkflowJob("aaaa1111");
    expect(record?.runId).toBe("run_a");
    expect(record?.status).toBe("running");
  });

  it("lists jobs newest first and ignores unrelated files", async () => {
    await writeJob(dir, { id: "bbbb2222", runId: "run_a", startedAt: "2026-01-01T00:00:00.000Z" });
    await writeJob(dir, { id: "cccc3333", runId: "run_b", startedAt: "2026-02-01T00:00:00.000Z" });
    await writeFile(join(dir, "jobs", "notes.txt"), "ignore me", "utf8");

    const jobs = await listWorkflowJobs();
    expect(jobs.map((j) => j.id)).toEqual(["cccc3333", "bbbb2222"]);
  });

  it("treats a live pid as running", async () => {
    // This process is definitionally alive.
    expect(isWorkflowJobAlive({ id: "x", runId: "r", target: "t", status: "running", startedAt: "", pid: process.pid })).toBe(true);
  });

  it("treats a finished job and a dead pid as not running", async () => {
    const finished: WorkflowJobRecord = { id: "x", runId: "r", target: "t", status: "finished", startedAt: "", pid: process.pid };
    expect(isWorkflowJobAlive(finished)).toBe(false);

    // A pid far above any real allocation is reliably absent.
    const dead: WorkflowJobRecord = { id: "y", runId: "r", target: "t", status: "running", startedAt: "", pid: 0x7ffffff0 };
    expect(isWorkflowJobAlive(dead)).toBe(false);
  });

  it("treats a job with no pid as not running", async () => {
    expect(isWorkflowJobAlive({ id: "x", runId: "r", target: "t", status: "starting", startedAt: "" })).toBe(false);
  });

  it("never reports a finished job as orphaned", async () => {
    await writeJob(dir, { id: "done1111", runId: "run_a", status: "finished", pid: 0x7ffffff0, finishedAt: new Date().toISOString() });
    await writeJob(dir, { id: "live1111", runId: "run_b", pid: process.pid });

    const orphans = await listOrphanedWorkflowJobs();
    expect(orphans.map((j) => j.id)).not.toContain("done1111");
    expect(orphans.map((j) => j.id)).not.toContain("live1111");
  });

  it("marks a job finished and records its outcome", async () => {
    await writeJob(dir, { id: "aaaa1111", runId: "run_a", pid: process.pid });
    const finished = await markWorkflowJobFinished("aaaa1111", { exitCode: 3, signal: null });
    expect(finished?.status).toBe("finished");
    expect(finished?.exitCode).toBe(3);
    expect(isWorkflowJobAlive(finished!)).toBe(false);
  });

  it("returns null when marking an unknown job", async () => {
    expect(await markWorkflowJobFinished("nope")).toBeNull();
  });

  it("writes, detects and clears a stop request", async () => {
    expect(await isStopRequested("run_a")).toBe(false);
    expect(await requestStop("run_a")).toBe(true);
    expect(await isStopRequested("run_a")).toBe(true);
    clearStopRequest("run_a");
    expect(await isStopRequested("run_a")).toBe(false);
  });

  it("notifies a watcher when a request appears", async () => {
    let fired = false;
    const stopWatching = watchForStopRequest("run_watch1", () => { fired = true; }, 20);

    await requestStop("run_watch1");
    await new Promise((resolve) => setTimeout(resolve, 150));
    stopWatching();

    expect(fired).toBe(true);
  });

  it("does not notify after the watcher is disposed", async () => {
    let fired = 0;
    const stopWatching = watchForStopRequest("run_watch2", () => { fired++; }, 20);
    stopWatching();

    await requestStop("run_watch2");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fired).toBe(0);
  });

  it("fires a watcher only once", async () => {
    let fired = 0;
    const stopWatching = watchForStopRequest("run_watch3", () => { fired++; }, 20);

    await requestStop("run_watch3");
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopWatching();

    expect(fired).toBe(1);
  });

  it("keeps a live job however old it is", async () => {
    await writeJob(dir, { id: "live1111", runId: "run_a", pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" });
    expect(await pruneWorkflowJobs(0, Date.now())).toBe(0);
    expect(await readWorkflowJob("live1111")).not.toBeNull();
  });

  it("prunes an old finished job", async () => {
    await writeJob(dir, {
      id: "old11111",
      runId: "run_old",
      status: "finished",
      exitCode: 0,
      startedAt: "2000-01-01T00:00:00.000Z",
      finishedAt: "2000-01-02T00:00:00.000Z",
    });

    const removed = await pruneWorkflowJobs(1000, Date.now());
    expect(removed).toBe(1);
    expect(await readWorkflowJob("old11111")).toBeNull();
  });

  it("keeps a recently finished job", async () => {
    await writeJob(dir, {
      id: "new11111",
      runId: "run_a",
      status: "finished",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    expect(await pruneWorkflowJobs(60_000, Date.now())).toBe(0);
    expect(await readWorkflowJob("new11111")).not.toBeNull();
  });

  it("formats a job with its id, run and state", async () => {
    await writeJob(dir, { id: "aaaa1111", runId: "run_a", pid: process.pid });
    const record = await readWorkflowJob("aaaa1111");
    const text = formatWorkflowJob(record!);
    expect(text).toContain("aaaa1111");
    expect(text).toContain("run_a");
    expect(text).toContain("running");
  });

  it("shows an orphaned state for a job whose child vanished", async () => {
    await writeJob(dir, { id: "gone1111", runId: "run_a", pid: 0x7ffffff0 });
    const record = await readWorkflowJob("gone1111");
    expect(formatWorkflowJob(record!)).toContain("orphaned");
  });

  it("shows an exit code for a finished job", async () => {
    await writeJob(dir, { id: "fail1111", runId: "run_a", status: "finished", exitCode: 2 });
    const record = await readWorkflowJob("fail1111");
    expect(formatWorkflowJob(record!)).toContain("exit 2");
  });

  it("surfaces an error recorded on a job", async () => {
    await writeJob(dir, { id: "err11111", runId: "run_a", status: "finished", exitCode: 1, error: "boom" });
    const record = await readWorkflowJob("err11111");
    expect(formatWorkflowJob(record!)).toContain("boom");
  });

  it("leaves no stray temp files behind", async () => {
    await writeJob(dir, { id: "aaaa1111", runId: "run_a", pid: process.pid });
    await markWorkflowJobFinished("aaaa1111");
    const files = await readdir(join(dir, "jobs"));
    expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
