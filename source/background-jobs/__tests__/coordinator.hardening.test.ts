/**
 * WP-06 (plan item 0.2) — admission tolerates transient coordinator-lock
 * contention via a bounded, jittered retry.
 *
 * Imports the coordinator from source. The supervisor launcher is mocked so
 * no real supervisor process is spawned: the fake launch immediately marks
 * the job "running" so `start()` doesn't sit out its poll window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../coordinator/launcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../coordinator/launcher.js")>();
  return {
    ...original,
    launchSupervisorForJob: vi.fn(async (args: { jobId: string; repositories: import("../types.js").Repositories }) => {
      await args.repositories.jobs.update(args.jobId, { state: "running", startedAt: new Date().toISOString() });
      return { identity: { pid: 0, creationIdentity: "unavailable" }, ownershipHandle: "fake", ownershipScope: "unverified" as const };
    }),
  };
});

import { createCoordinator, type AdmissionRetryOptions } from "../coordinator/service.js";
import { launchSupervisorForJob } from "../coordinator/launcher.js";
import { getPlatformAdapter } from "../platform/index.js";
import { lockPath } from "../storage/paths.js";
import { BackgroundJobError, type SessionPolicySnapshot, type StartJobRequest } from "../types.js";

const session: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-coord-hardening-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function request(overrides: Partial<StartJobRequest> = {}): StartJobRequest {
  return {
    requestId: randomUUID(),
    invocation: { mode: "direct", executable: process.execPath, args: [] },
    cwd: base,
    isolation: { backend: "none", required: false },
    ...overrides,
  };
}

/**
 * Hold the coordinator lock with a fake LIVE holder (this test process's own
 * pid, same host, no start time recorded), so verified-gone recovery (WP-02)
 * never steals it.
 */
async function holdCoordinatorLock(root: string): Promise<string> {
  const path = lockPath(root, "coordinator");
  await mkdir(join(root, "locks"), { recursive: true });
  await writeFile(path, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), hostname: hostname() }));
  return path;
}

function recordingRetry(onSleep?: (call: number) => Promise<void> | void): AdmissionRetryOptions & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      await onSleep?.(sleeps.length);
    },
  };
}

async function countCoordinatorLockAcquisitions(root: string) {
  const adapter = await getPlatformAdapter();
  const original = adapter.acquireLock.bind(adapter);
  const coordinatorLock = lockPath(root, "coordinator");
  const calls = { count: 0 };
  vi.spyOn(adapter, "acquireLock").mockImplementation(async (path: string) => {
    if (path === coordinatorLock) calls.count++;
    return original(path);
  });
  return calls;
}

describe("coordinator admission lock retry (0.2)", () => {
  it("succeeds once a contended coordinator lock is released within the retry budget", async () => {
    let lockFile = "";
    const retry = recordingRetry(async (call) => {
      if (call === 3) await unlink(lockFile); // holder releases after 3 backoffs
    });
    const coordinator = await createCoordinator({ root: base, admissionRetry: retry });
    lockFile = await holdCoordinatorLock(coordinator.root);
    const calls = await countCoordinatorLockAcquisitions(coordinator.root);

    const summary = await coordinator.start(request(), session);

    expect(summary.state).toBe("running");
    expect(retry.sleeps).toHaveLength(3);
    expect(calls.count).toBe(4);
    expect(await coordinator.repositories.jobs.list()).toHaveLength(1);
  });

  it("rethrows lock-held after exactly 10 attempts with each backoff in [20, 100] ms", async () => {
    const retry = recordingRetry();
    const coordinator = await createCoordinator({ root: base, admissionRetry: retry });
    await holdCoordinatorLock(coordinator.root);
    const calls = await countCoordinatorLockAcquisitions(coordinator.root);

    const error = await coordinator.start(request(), session).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BackgroundJobError);
    expect((error as BackgroundJobError).code).toBe("lock-held");
    expect(calls.count).toBe(10);
    expect(retry.sleeps).toHaveLength(9);
    for (const ms of retry.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(20);
      expect(ms).toBeLessThanOrEqual(100);
    }
    expect(await coordinator.repositories.jobs.list()).toEqual([]);
  });

  it("keeps the jitter inside [20, 100] ms at the random source's extremes", async () => {
    for (const value of [0, 0.999999]) {
      const retry = { ...recordingRetry(), random: () => value, maxAttempts: 2 };
      const root = join(base, `r${value}`);
      const coordinator = await createCoordinator({ root, admissionRetry: retry });
      await holdCoordinatorLock(coordinator.root);
      await expect(coordinator.start(request({ cwd: base }), session)).rejects.toMatchObject({ code: "lock-held" });
      expect(retry.sleeps).toEqual([value === 0 ? 20 : 100]);
    }
  });

  it("does not retry a non-lock-held error raised inside the locked section", async () => {
    const retry = recordingRetry();
    const coordinator = await createCoordinator({ root: base, admissionRetry: retry });
    const calls = await countCoordinatorLockAcquisitions(coordinator.root);

    await expect(
      coordinator.start(request({ limits: { maxConcurrentJobs: 0 } }), session),
    ).rejects.toMatchObject({ code: "capacity-exceeded" });

    expect(calls.count).toBe(1);
    expect(retry.sleeps).toEqual([]);
  });

  it("does not retry a lock-held error thrown by the locked callback itself", async () => {
    const retry = recordingRetry();
    const coordinator = await createCoordinator({ root: base, admissionRetry: retry });
    const calls = await countCoordinatorLockAcquisitions(coordinator.root);
    vi.spyOn(coordinator.repositories.specs, "put").mockRejectedValue(
      new BackgroundJobError("lock-held", "inner lock contention"),
    );

    await expect(coordinator.start(request(), session)).rejects.toMatchObject({
      code: "lock-held",
      message: "inner lock contention",
    });
    expect(calls.count).toBe(1);
    expect(retry.sleeps).toEqual([]);
  });
});


describe("post-launch supervisor ownership persistence", () => {
  it("survives contention beyond the old five-attempt budget without relaunching", async () => {
    const coordinator = await createCoordinator({ root: base });
    const update = coordinator.repositories.jobs.update.bind(coordinator.repositories.jobs);
    let ownershipAttempts = 0;
    vi.spyOn(coordinator.repositories.jobs, "update").mockImplementation(async (id, patch) => {
      if (patch.supervisorIdentity && ++ownershipAttempts <= 6) {
        throw new BackgroundJobError("lock-held", "supervisor is publishing its state");
      }
      return update(id, patch);
    });
    vi.mocked(launchSupervisorForJob).mockClear();

    const summary = await coordinator.start(request(), session);

    expect(ownershipAttempts).toBe(7);
    expect(launchSupervisorForJob).toHaveBeenCalledTimes(1);
    expect(await coordinator.repositories.jobs.get(summary.jobId)).toMatchObject({
      state: "running",
      supervisorIdentity: { pid: 0, creationIdentity: "unavailable" },
      supervisorOwnershipHandle: "fake",
      supervisorOwnershipScope: "unverified",
    });
  });

  it("bounds retries for a persistently held job lock", async () => {
    const coordinator = await createCoordinator({ root: base });
    const update = coordinator.repositories.jobs.update.bind(coordinator.repositories.jobs);
    let ownershipAttempts = 0;
    vi.spyOn(coordinator.repositories.jobs, "update").mockImplementation(async (id, patch) => {
      if (patch.supervisorIdentity) {
        ownershipAttempts++;
        throw new BackgroundJobError("lock-held", "persistent contention");
      }
      return update(id, patch);
    });
    vi.mocked(launchSupervisorForJob).mockClear();

    await expect(coordinator.start(request(), session)).rejects.toMatchObject({
      code: "lock-held", message: "persistent contention",
    });
    expect(ownershipAttempts).toBe(21);
    expect(launchSupervisorForJob).toHaveBeenCalledTimes(1);
  }, 10000);

  it("does not retry unrelated ownership persistence errors", async () => {
    const coordinator = await createCoordinator({ root: base });
    const update = coordinator.repositories.jobs.update.bind(coordinator.repositories.jobs);
    let ownershipAttempts = 0;
    vi.spyOn(coordinator.repositories.jobs, "update").mockImplementation(async (id, patch) => {
      if (patch.supervisorIdentity) {
        ownershipAttempts++;
        throw new Error("disk failure");
      }
      return update(id, patch);
    });

    await expect(coordinator.start(request(), session)).rejects.toThrow("disk failure");
    expect(ownershipAttempts).toBe(1);
  });
});
