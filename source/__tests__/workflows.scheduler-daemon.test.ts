import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonPaths } from "../workflows/scheduler-daemon.js";

/**
 * The daemon exists so a schedule fires with no interactive session open. It owns
 * only the loop, a single-instance lock, and logging — the tick rules stay in
 * `tick`, shared with the interactive ticker, so the two cannot drift.
 */
describe("scheduler daemon", () => {
  let dir: string;
  let paths: DaemonPaths;
  let previousConfigDir: string | undefined;
  let scheduler: typeof import("../config/scheduler.js");
  let daemonModule: typeof import("../workflows/scheduler-daemon.js");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-daemon-"));
    paths = {
      daemonFile: join(dir, "daemon.json"),
      lockFile: join(dir, "daemon.lock"),
      logFile: join(dir, "scheduler.log"),
    };
    previousConfigDir = process.env["AGAV_CONFIG_DIR"];
    process.env["AGAV_CONFIG_DIR"] = dir;
    vi.resetModules();
    await load();
  });

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env["AGAV_CONFIG_DIR"];
    else process.env["AGAV_CONFIG_DIR"] = previousConfigDir;
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Import the state-owning modules inside beforeEach. getAgavDir() caches
   * AGAV_CONFIG_DIR at import time, so a static import would bind to the real
   * home directory and write live state instead of the test's temp dir.
   */
  const load = async () => {
    scheduler = await import("../config/scheduler.js");
    daemonModule = await import("../workflows/scheduler-daemon.js");
  };

  /** Seed one task that is always due, so tick does real work and probes liveness. */
  const seedDueTask = async () => {
    await load();
    await scheduler.saveScheduledTask({
      id: "due",
      name: "always-due",
      cron: "* * * * *",
      prompt: "wf.yaml",
      kind: "workflow",
      enabled: true,
      createdAt: new Date().toISOString(),
    } as never);
  };

  const writeRecord = async (record: unknown) => {
    await writeFile(paths.daemonFile, JSON.stringify(record), "utf8");
  };

  describe("readDaemonRecord", () => {
    it("returns null when no record exists", async () => {
      expect(await daemonModule.readDaemonRecord(paths)).toBeNull();
    });

    it("returns the record for a live pid", async () => {
      await writeRecord({ id: "a", pid: process.pid, startedAt: new Date().toISOString(), version: 1 });
      const record = await daemonModule.readDaemonRecord(paths);
      expect(record?.pid).toBe(process.pid);
    });

    it("treats a record whose process is gone as stale", async () => {
      // A crashed daemon must not make a new one look like a duplicate, which
      // would leave scheduling permanently off.
      await writeRecord({ id: "a", pid: 0x7ffffff0, startedAt: new Date().toISOString(), version: 1 });
      expect(await daemonModule.readDaemonRecord(paths)).toBeNull();
    });

    it("returns null for a malformed record rather than throwing", async () => {
      await writeFile(paths.daemonFile, "{not json", "utf8");
      expect(await daemonModule.readDaemonRecord(paths)).toBeNull();
    });

    it("returns null for a record with no pid", async () => {
      await writeRecord({ id: "a", startedAt: "now", version: 1 });
      expect(await daemonModule.readDaemonRecord(paths)).toBeNull();
    });
  });

  describe("runDaemon", () => {
    let ticks: unknown[][] = [];
    it("evaluates immediately on start, so a fire missed while nothing ran is caught", async () => {
      const ticks: unknown[][] = [];
      const running = daemonModule.runDaemon({
        paths,
        pollMs: 60_000,
        tickDeps: {
          isTaskRunning: () => false,
          startWorkflow: async () => null,
        },
        onTick: (d) => ticks.push(d),
      });

      // Let the first evaluation complete before stopping.
      await new Promise((r) => setTimeout(r, 30));
      process.emit("SIGTERM");
      await running;

      expect(ticks.length).toBeGreaterThanOrEqual(1);
    });

    it("records itself so status can find it", async () => {
      const running = daemonModule.runDaemon({ paths, pollMs: 60_000, tickDeps: { isTaskRunning: () => false } });
      await new Promise((r) => setTimeout(r, 30));

      const record = await daemonModule.readDaemonRecord(paths);
      expect(record?.pid).toBe(process.pid);

      process.emit("SIGTERM");
      await running;
    });

    it("clears its record on a clean stop", async () => {
      const running = daemonModule.runDaemon({ paths, pollMs: 60_000, tickDeps: { isTaskRunning: () => false } });
      await new Promise((r) => setTimeout(r, 30));
      process.emit("SIGTERM");
      await running;

      // A stale record would make the next start look like a duplicate.
      expect(await daemonModule.readDaemonRecord(paths)).toBeNull();
    });

    it("refuses to start when a live daemon already owns the schedule", async () => {
      await writeRecord({ id: "other", pid: process.pid, startedAt: new Date().toISOString(), version: 1 });

      await expect(
        daemonModule.runDaemon({ paths, pollMs: 60_000, tickDeps: { isTaskRunning: () => false } }),
      ).rejects.toThrow(/already running/i);
    });

    it("keeps running when a single tick throws", async () => {
      // One bad tick must not end the daemon: the schedule would then never run
      // again, with nothing to signal it.
      await seedDueTask();
      let calls = 0;
      const running = daemonModule.runDaemon({
        paths,
        pollMs: 20,
        tickDeps: {
          isTaskRunning: () => {
            calls++;
            if (calls === 1) throw new Error("transient failure");
            return false;
          },
          startWorkflow: async () => null,
        },
        onTick: (d) => ticks.push(d),
      });

      await new Promise((r) => setTimeout(r, 200));
      process.emit("SIGTERM");
      await running;

      // It kept ticking after the failure, so the daemon survived.
      expect(calls).toBeGreaterThan(1);
    });

    it("logs each tick failure instead of throwing it", async () => {
      await seedDueTask();
      const running = daemonModule.runDaemon({
        paths,
        pollMs: 60_000,
        tickDeps: {
          isTaskRunning: () => {
            throw new Error("boom");
          },
        },
      });
      await new Promise((r) => setTimeout(r, 60));
      process.emit("SIGTERM");
      await running;

      const log = await readFile(paths.logFile, "utf8");
      expect(log).toContain("boom");
    });

    it("does not clobber a record owned by another daemon when cleaning up", async () => {
      const running = daemonModule.runDaemon({ paths, pollMs: 60_000, tickDeps: { isTaskRunning: () => false } });
      await new Promise((r) => setTimeout(r, 30));

      // Another daemon took over while this one was stopping.
      await writeRecord({ id: "other", pid: process.pid, startedAt: new Date().toISOString(), version: 1 });

      process.emit("SIGTERM");
      await running;

      const record = await daemonModule.readDaemonRecord(paths);
      expect(record?.id).toBe("other");
    });
  });

  describe("stopDaemon", () => {
    it("returns null when nothing is running", async () => {
      expect(await daemonModule.stopDaemon(paths)).toBeNull();
    });

    it("returns null for a stale record rather than signalling a dead pid", async () => {
      await writeRecord({ id: "a", pid: 0x7ffffff0, startedAt: "now", version: 1 });
      expect(await daemonModule.stopDaemon(paths)).toBeNull();
    });
  });
});