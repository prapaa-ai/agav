/**
 * WP-13 (1.6) — concurrent-host safety tests.
 *
 * Simulates several hosts (app ticker, daemon, CLI tick) evaluating the same
 * temp store concurrently, in-process. Each "host" builds its own schedule
 * engine + repositories + authorization service over one shared root. A fake
 * coordinator records `start()` calls with a random 0–20 ms delay to widen
 * the interleaving window. Asserts each due occurrence is dispatched once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { lockPath, quarantineDir } from "../storage/paths.js";
import { withCoordinatorLock } from "../storage/single-writer-lock.js";
import { acquireDaemonLock, daemonLockPath } from "../host/daemon.js";
import {
  BackgroundJobError,
  DEFAULT_RESOURCE_LIMITS,
  type CoordinatorClient,
  type JobSummary,
  type LaunchSpec,
  type SessionPolicySnapshot,
  type StartJobRequest,
} from "../types.js";
import { createFileRepositories } from "../storage/repositories.js";
import { createAuthorizationService } from "../authorization/service.js";
import { createScheduleEngine, type ScheduleEngine } from "../schedule/engine.js";
import type { Coordinator } from "../coordinator/index.js";
import { runBackgroundTick } from "../../background-jobs-integration.js";

const autoAcceptSession: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };
const denyWritesSession: SessionPolicySnapshot = { permissionMode: "deny-writes", headlessApprovedActions: [] };

const CRON = "0 3 * * *";
const DUE = new Date("2024-03-10T03:00:00Z");
const HOSTS = 8;

function buildLaunchSpecTemplate(): Omit<LaunchSpec, "requestId" | "createdAt"> {
  return {
    invocation: { mode: "direct", executable: "/bin/echo", args: ["hi"] },
    cwd: "/tmp",
    env: {},
    credentialRefs: [],
    isolation: { backend: "none", required: false },
    ownershipScope: "process-group",
    limits: DEFAULT_RESOURCE_LIMITS,
    headless: false,
  };
}

function createFakeCoordinator(opts?: { throwOnFirst?: boolean }) {
  const calls: StartJobRequest[] = [];
  let first = true;
  return {
    calls,
    async start(request: StartJobRequest, _session: SessionPolicySnapshot): Promise<JobSummary> {
      calls.push(request);
      const shouldThrow = opts?.throwOnFirst === true && first;
      first = false;
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 21)));
      if (shouldThrow) throw new Error("simulated crash between reserve and dispatch");
      return { jobId: randomUUID(), requestId: request.requestId, state: "running", stopState: "none" };
    },
  };
}

type FakeCoordinator = ReturnType<typeof createFakeCoordinator>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A pid that certainly belonged to a process on this host and has exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof result.pid !== "number" || result.pid <= 0) throw new Error("could not spawn a short-lived child");
  return result.pid;
}

/** Write a lock file in the platform holder format whose owner is verifiably gone (same host, dead pid). */
async function seedDeadOwnerLock(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    JSON.stringify({ pid: deadPid(), acquiredAt: new Date().toISOString(), processStartTime: "1", hostname: hostname() }),
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * The lock primitives never wait: a contended caller gets `lock-held` (or
 * `acquired: false`). Model a host retrying on its next tick until it gets in.
 */
async function retryWhileHeld(attempt: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    try {
      if (await attempt()) return;
    } catch (error) {
      if (!(error instanceof BackgroundJobError && error.code === "lock-held")) throw error;
    }
    await sleep(1 + Math.floor(Math.random() * 3));
  }
  throw new Error("lock never acquired");
}

describe("concurrent-host schedule safety (WP-13)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agav-host-concurrency-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A separately constructed "host": own repositories/auth/engine over the shared root. */
  function buildHost(fake: FakeCoordinator) {
    const repositories = createFileRepositories(root);
    const engine = createScheduleEngine({
      repositories,
      coordinator: fake as unknown as CoordinatorClient,
      authorizationService: createAuthorizationService(root),
      root,
    });
    return { repositories, engine };
  }

  async function createDueSchedule(fake: FakeCoordinator) {
    const { engine, repositories } = buildHost(fake);
    const schedule = await engine.createSchedule({
      cron: CRON,
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });
    return { schedule, repositories };
  }

  it("8 concurrent engines evaluating the same due occurrence dispatch exactly once", async () => {
    const fake = createFakeCoordinator();
    const { schedule, repositories } = await createDueSchedule(fake);
    const hosts = Array.from({ length: HOSTS }, () => buildHost(fake));

    const results = await Promise.all(
      hosts.map((h) => h.engine.evaluateOnce({ nowUtc: DUE, connectedSessions: [autoAcceptSession] })),
    );
    expect(fake.calls).toHaveLength(1);
    const outcomes = results.flat().filter((r) => r.scheduleId === schedule.scheduleId).map((r) => r.outcome);
    expect(outcomes.filter((o) => o === "dispatched")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped-overlap")).toHaveLength(HOSTS - 1);

    const occurrences = await repositories.occurrences.listForSchedule(schedule.scheduleId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("dispatched");

    // Repeat evaluation (concurrently and sequentially) — still exactly one start().
    await Promise.all(
      Array.from({ length: HOSTS }, () =>
        buildHost(fake).engine.evaluateOnce({ nowUtc: DUE, connectedSessions: [autoAcceptSession] }),
      ),
    );
    await hosts[0]!.engine.evaluateOnce({ nowUtc: new Date(DUE.getTime() + 30_000), connectedSessions: [] });
    expect(fake.calls).toHaveLength(1);
    expect(await repositories.occurrences.listForSchedule(schedule.scheduleId)).toHaveLength(1);
  });

  it("8 concurrent runBackgroundTick calls dispatch exactly once in total", async () => {
    const fake = createFakeCoordinator();
    const { schedule, repositories } = await createDueSchedule(fake);

    const summaries = await Promise.all(
      Array.from({ length: HOSTS }, () =>
        runBackgroundTick({
          coordinator: fake as unknown as Coordinator,
          scheduleEngine: buildHost(fake).engine,
          session: autoAcceptSession,
          backgroundAutomation: "on",
          now: DUE,
        }),
      ),
    );
    expect(summaries.reduce((n, s) => n + s.dispatched, 0)).toBe(1);
    expect(summaries.reduce((n, s) => n + s.errors, 0)).toBe(0);
    expect(summaries.every((s) => !s.paused)).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(await repositories.occurrences.listForSchedule(schedule.scheduleId)).toHaveLength(1);
  });

  it("a crash between reserve and dispatch marks recovery-required and is never retried", async () => {
    const fake = createFakeCoordinator({ throwOnFirst: true });
    const { schedule, repositories } = await createDueSchedule(fake);

    const results = await Promise.all(
      Array.from({ length: HOSTS }, () =>
        buildHost(fake).engine.evaluateOnce({ nowUtc: DUE, connectedSessions: [autoAcceptSession] }),
      ),
    );
    expect(fake.calls).toHaveLength(1);
    expect(results.flat().filter((r) => r.outcome === "dispatched")).toHaveLength(0);

    const occurrences = await repositories.occurrences.listForSchedule(schedule.scheduleId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("recovery-required");

    // Subsequent concurrent evaluations of the same occurrence never call start() again.
    await Promise.all(
      Array.from({ length: HOSTS }, () =>
        buildHost(fake).engine.evaluateOnce({ nowUtc: DUE, connectedSessions: [autoAcceptSession] }),
      ),
    );
    expect(fake.calls).toHaveLength(1);
    const after = await repositories.occurrences.listForSchedule(schedule.scheduleId);
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe("recovery-required");
  });

  it("a deny-writes session suppresses all dispatches across concurrent hosts", async () => {
    const fake = createFakeCoordinator();
    const { schedule, repositories } = await createDueSchedule(fake);

    const summaries = await Promise.all(
      Array.from({ length: HOSTS }, () =>
        runBackgroundTick({
          scheduleEngine: buildHost(fake).engine,
          session: [autoAcceptSession, denyWritesSession],
          backgroundAutomation: "on",
          now: DUE,
        }),
      ),
    );
    expect(summaries.reduce((n, s) => n + s.dispatched, 0)).toBe(0);
    for (const s of summaries) {
      expect(s.results.find((r) => r.scheduleId === schedule.scheduleId)?.outcome).toBe("skipped-restrictive-policy");
    }
    expect(fake.calls).toHaveLength(0);
    expect(await repositories.occurrences.listForSchedule(schedule.scheduleId)).toHaveLength(0);
  });

  it("stale coordinator lock: one quarantine under 8-way contention, every caller runs exactly once, no overlap", async () => {
    const path = lockPath(root, "coordinator");
    await seedDeadOwnerLock(path);

    const runs = new Array<number>(HOSTS).fill(0);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: HOSTS }, (_, i) =>
        retryWhileHeld(async () => {
          await withCoordinatorLock(root, async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            runs[i] = (runs[i] ?? 0) + 1;
            await sleep(Math.floor(Math.random() * 6));
            active -= 1;
          });
          return true;
        }),
      ),
    );

    expect(runs).toEqual(new Array<number>(HOSTS).fill(1));
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    const quarantined = await readdir(quarantineDir(root));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.startsWith(`${basename(path)}.stale-`)).toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${path}.recovery`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stale daemon lock: one quarantine under 8-way contention, every caller holds it exactly once, no overlap", async () => {
    const path = daemonLockPath(root);
    await seedDeadOwnerLock(path);

    const runs = new Array<number>(HOSTS).fill(0);
    let active = 0;
    let maxActive = 0;
    // Retries overlap first attempts, so no caller is guaranteed to acquire on its first attempt.
    await Promise.all(
      Array.from({ length: HOSTS }, (_, i) =>
        retryWhileHeld(async () => {
          const lock = await acquireDaemonLock(root, "test");
          if (!lock.acquired) return false;
          active += 1;
          maxActive = Math.max(maxActive, active);
          runs[i] = (runs[i] ?? 0) + 1;
          await sleep(Math.floor(Math.random() * 6));
          active -= 1;
          await lock.release();
          return true;
        }),
      ),
    );

    expect(runs).toEqual(new Array<number>(HOSTS).fill(1));
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    const quarantined = await readdir(quarantineDir(root));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.startsWith(`${basename(path)}.stale-`)).toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${path}.recovery`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backgroundAutomation 'paused' dispatches nothing and never consults the engine", async () => {
    const fake = createFakeCoordinator();
    const { schedule, repositories } = await createDueSchedule(fake);
    let consulted = 0;
    const real = buildHost(fake).engine;
    const spyEngine: ScheduleEngine = {
      ...real,
      async evaluateOnce(args) {
        consulted += 1;
        return real.evaluateOnce(args);
      },
    };

    const summaries = await Promise.all(
      Array.from({ length: HOSTS }, () =>
        runBackgroundTick({
          scheduleEngine: spyEngine,
          session: autoAcceptSession,
          backgroundAutomation: "paused",
          now: DUE,
        }),
      ),
    );
    expect(summaries.every((s) => s.paused && s.dispatched === 0 && s.results.length === 0)).toBe(true);
    expect(consulted).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(await repositories.occurrences.listForSchedule(schedule.scheduleId)).toHaveLength(0);
  });
});
