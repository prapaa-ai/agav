import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The reported symptom was a task skipped as "previous run still in flight" every
 * tick, forever. The cause was orphaned job records: a child that died without
 * closing its record out stayed `running`, and the overlap guard trusted it. The
 * tick now reconciles orphans before acting.
 *
 * `getAgavDir()` captures `AGAV_CONFIG_DIR` at import time, so the module registry
 * is reset in beforeEach and the modules re-imported against the fresh temp dir.
 * Without that, a second test inherits the first test's deleted directory.
 */
describe("tick reconciles orphaned job records", () => {
  let dir: string;
  let previousConfigDir: string | undefined;
  let jobs: typeof import("../workflows/jobs.js");
  let scheduleRun: typeof import("../workflows/schedule-run.js");
  let scheduler: typeof import("../config/scheduler.js");

  const load = async () => {
    jobs = await import("../workflows/jobs.js");
    scheduleRun = await import("../workflows/schedule-run.js");
    scheduler = await import("../config/scheduler.js");
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-orphan-"));
    previousConfigDir = process.env["AGAV_CONFIG_DIR"];
    process.env["AGAV_CONFIG_DIR"] = dir;
    // getAgavDir() caches AGAV_CONFIG_DIR at import; reset so each test re-imports
    // against the fresh temp dir rather than a previous test's deleted one.
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env["AGAV_CONFIG_DIR"];
    else process.env["AGAV_CONFIG_DIR"] = previousConfigDir;
    await rm(dir, { recursive: true, force: true });
  });

  const writeDeadJob = async (target: string, runId: string) => {
    await load();
    const fs = await import("node:fs/promises");
    // Mirrors jobsDir(): AGAV_CONFIG_DIR is set, so jobs live under <dir>/workflow-jobs.
    const jobsDirValue = join(process.env["AGAV_CONFIG_DIR"]!, "workflow-jobs");
    await fs.mkdir(jobsDirValue, { recursive: true });
    // A pid that does not exist, so signal 0 against it fails and the record reads
    // as orphaned.
    await fs.writeFile(
      join(jobsDirValue, `boot_${runId}.json`),
      JSON.stringify({
        id: `boot_${runId}`,
        target,
        runId,
        status: "running",
        pid: 0xffffff,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );
  };

  it("fires a task whose only blocker was a stale job record", async () => {
    await load();
    await scheduler.saveScheduledTask({
      id: "t1",
      name: "nightly",
      cron: "* * * * *",
      prompt: "wf.yaml",
      kind: "workflow",
      enabled: true,
      createdAt: new Date().toISOString(),
    } as import("../config/scheduler.js").ScheduledTask);

    // Orphan: a job whose child is gone but whose record still says running. A
    // dead pid is the only way to make one deterministically — spawning a real
    // child would be alive and correctly left alone.
    await writeDeadJob("wf.yaml", "run_orphan");
    expect((await jobs.listWorkflowJobs()).some((job) => job.status === "running")).toBe(true);

    const decisions = await scheduleRun.tick({
      startWorkflow: async () => "run_new",
      now: () => {
        const d = new Date();
        d.setHours(3, 0, 0, 0);
        return d;
      },
    });

    // The orphan is reconciled, so the task is no longer considered running.
    expect((await jobs.listWorkflowJobs()).find((job) => job.runId === "run_orphan")?.status).toBe("finished");
    expect(decisions[0].fire).toBe(true);
  });

  it("does not fire a task whose run genuinely is still going", async () => {
    await load();
    await scheduler.saveScheduledTask({
      id: "t2",
      name: "live",
      cron: "* * * * *",
      prompt: "wf.yaml",
      kind: "workflow",
      enabled: true,
      createdAt: new Date().toISOString(),
    } as import("../config/scheduler.js").ScheduledTask);

    const decisions = await scheduleRun.tick({
      isTaskRunning: (task) => task.id === "t2",
      startWorkflow: async () => "run_new",
      now: () => {
        const d = new Date();
        d.setHours(3, 0, 0, 0);
        return d;
      },
    });

    expect(decisions.find((d) => d.task.id === "t2")?.skip).toBe("already-running");
  });

  it("reconciles several orphans in one pass", async () => {
    await load();
    await writeDeadJob("wf.yaml", "run_a");
    await writeDeadJob("wf.yaml", "run_b");

    await scheduleRun.tick({
      startWorkflow: async () => "run_new",
      now: () => {
        const d = new Date();
        d.setHours(3, 0, 0, 0);
        return d;
      },
    });

    expect((await jobs.listWorkflowJobs()).filter((job) => job.status === "finished")).toHaveLength(2);
  });
});
