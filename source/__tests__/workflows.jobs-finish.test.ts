import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWorkflowJobs,
  markWorkflowJobFinishedByRunId,
  readWorkflowJob,
} from "../workflows/jobs.js";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Write a job record in the same on-disk shape the module itself uses, so the
 * marker operates on a realistic record rather than a synthetic one.
 */
async function writeJobRecord(jobsDir: string, record: { id: string; runId: string; pid?: number }): Promise<void> {
  await mkdir(jobsDir, { recursive: true });
  await writeFile(
    join(jobsDir, `${record.id}.json`),
    JSON.stringify({
      target: "wf.yaml",
      status: "running",
      startedAt: new Date().toISOString(),
      ...record,
    }),
    "utf8",
  );
}

/**
 * The reported symptom was a scheduled task skipped as "previous run still in
 * flight" forever. The cause was a job record left `running` after its child
 * exited: the parent that spawned it had already gone, so nothing closed the
 * record out, and the overlap guard trusted the stale record. These tests pin
 * the child-side finish marker.
 */
describe("child-side job finish marker", () => {
  let dir: string;
  let previousJobDir: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-finish-"));
    previousJobDir = process.env["AGAV_WORKFLOW_JOB_DIR"];
    process.env["AGAV_WORKFLOW_JOB_DIR"] = join(dir, "jobs");
    await writeJobRecord(join(dir, "jobs"), { id: "boot1111", runId: "run_boot" });
    await markWorkflowJobFinishedByRunId("run_boot");
  });

  afterEach(async () => {
    if (previousJobDir === undefined) delete process.env["AGAV_WORKFLOW_JOB_DIR"];
    else process.env["AGAV_WORKFLOW_JOB_DIR"] = previousJobDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("marks the record for this run id finished", async () => {
    await writeJobRecord(join(dir, "jobs"), { id: "aaaa1111", runId: "run_a", pid: process.pid });

    const finished = await markWorkflowJobFinishedByRunId("run_a", { exitCode: 0 });

    expect(finished?.status).toBe("finished");
    expect(await readWorkflowJob("aaaa1111")).toMatchObject({ status: "finished" });
  });

  it("does not mark a record whose child is a different process", async () => {
    // A pid that is not this process: the child is somewhere else, so this
    // process must not close its record out.
    await writeJobRecord(join(dir, "jobs"), { id: "bbbb2222", runId: "run_b", pid: 0x7ffffff0 });

    const finished = await markWorkflowJobFinishedByRunId("run_b", { exitCode: 0 });

    expect(finished).toBeNull();
    expect(await readWorkflowJob("bbbb2222")).toMatchObject({ status: "running" });
  });

  it("marks a record with no recorded pid, which is what a launch failure leaves", async () => {
    await writeJobRecord(join(dir, "jobs"), { id: "cccc3333", runId: "run_c" });

    const finished = await markWorkflowJobFinishedByRunId("run_c", { exitCode: 1 });

    expect(finished?.status).toBe("finished");
  });

  it("returns null when there is nothing to close", async () => {
    expect(await markWorkflowJobFinishedByRunId("run_missing")).toBeNull();
  });

  it("does not re-finish an already finished record", async () => {
    await writeJobRecord(join(dir, "jobs"), { id: "dddd4444", runId: "run_d", pid: process.pid });
    await markWorkflowJobFinishedByRunId("run_d", { exitCode: 0 });

    // A second exit must not overwrite the recorded outcome.
    const again = await markWorkflowJobFinishedByRunId("run_d", { exitCode: 7 });

    expect(again).toBeNull();
    expect(await readWorkflowJob("dddd4444")).toMatchObject({ status: "finished", exitCode: 0 });
  });

  it("leaves other runs' records untouched", async () => {
    await writeJobRecord(join(dir, "jobs"), { id: "eeee5555", runId: "run_e", pid: process.pid });
    await writeJobRecord(join(dir, "jobs"), { id: "ffff6666", runId: "run_f", pid: process.pid });

    await markWorkflowJobFinishedByRunId("run_e", { exitCode: 0 });

    expect(await readWorkflowJob("ffff6666")).toMatchObject({ status: "running" });
  });

  it("closes every stale record out when several are left behind", async () => {
    await writeJobRecord(join(dir, "jobs"), { id: "aaaa1111", runId: "run_a", pid: process.pid });
    await writeJobRecord(join(dir, "jobs"), { id: "bbbb2222", runId: "run_a", pid: process.pid });

    await markWorkflowJobFinishedByRunId("run_a", { exitCode: 0 });

    const remaining = (await listWorkflowJobs()).filter(
      (job) => job.runId === "run_a" && job.status !== "finished",
    );
    // One record per run id is closed, not all of them.
    expect(remaining).toHaveLength(1);
  });
});
