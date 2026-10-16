/**
 * Admission atomicity and launch-failure handling in `coordinator/service.ts`:
 *  - concurrent identical requests create exactly one job and launch once;
 *  - a retry after a crash between specs.put and jobs.create reuses the saved spec (no spec-changed);
 *  - a definite pre-spawn launch failure releases capacity; an ambiguous one does not.
 *
 * Imports the coordinator from source; the supervisor launcher is mocked so no process is spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const launcher = vi.hoisted(() => ({
  launch: undefined as unknown as (args: { jobId: string; repositories: import("../types.js").Repositories }) => Promise<unknown>,
}));

vi.mock("../coordinator/launcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../coordinator/launcher.js")>();
  return { ...original, launchSupervisorForJob: vi.fn((args: never) => launcher.launch(args)) };
});

import { launchSupervisorForJob } from "../coordinator/launcher.js";
import { createCoordinator } from "../coordinator/service.js";
import {
  BackgroundJobError,
  PreSpawnLaunchError,
  type Repositories,
  type SessionPolicySnapshot,
  type StartJobRequest,
} from "../types.js";

const session: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };

let base: string;

async function runningLaunch(args: { jobId: string; repositories: Repositories }) {
  await args.repositories.jobs.update(args.jobId, { state: "running", startedAt: new Date().toISOString() });
  return { identity: { pid: 0, creationIdentity: "unavailable" }, ownershipHandle: "fake", ownershipScope: "unverified" as const };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agav-coord-atomicity-"));
  launcher.launch = runningLaunch;
  vi.mocked(launchSupervisorForJob).mockClear();
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

describe("concurrent identical requests", () => {
  it("create exactly one job and launch one supervisor", async () => {
    const coordinator = await createCoordinator({ root: base });
    const req = request();

    const results = await Promise.all([
      coordinator.start(req, session),
      coordinator.start(req, session),
      coordinator.start(req, session),
    ]);

    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(await coordinator.repositories.jobs.list()).toHaveLength(1);
    expect(launchSupervisorForJob).toHaveBeenCalledTimes(1);
  });
});

describe("crash between spec save and job creation", () => {
  it("retry succeeds with the persisted spec instead of failing spec-changed", async () => {
    const coordinator = await createCoordinator({ root: base });
    const req = request();

    vi.spyOn(coordinator.repositories.jobs, "create").mockRejectedValueOnce(new Error("simulated crash"));
    await expect(coordinator.start(req, session)).rejects.toThrow("simulated crash");
    const saved = await coordinator.repositories.specs.get(req.requestId);
    expect(saved).toBeDefined();
    expect(await coordinator.repositories.jobs.list()).toHaveLength(0);

    // A re-normalized spec would get a later createdAt; make sure time moves on.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const summary = await coordinator.start(req, session);
    expect(summary.requestId).toBe(req.requestId);
    expect(await coordinator.repositories.jobs.list()).toHaveLength(1);
    expect(await coordinator.repositories.specs.get(req.requestId)).toEqual(saved);
  });

  it("still rejects the same requestId with a different launch spec", async () => {
    const coordinator = await createCoordinator({ root: base });
    const req = request();

    vi.spyOn(coordinator.repositories.jobs, "create").mockRejectedValueOnce(new Error("simulated crash"));
    await expect(coordinator.start(req, session)).rejects.toThrow("simulated crash");

    const changed = { ...req, invocation: { mode: "direct" as const, executable: process.execPath, args: ["-v"] } };
    await expect(coordinator.start(changed, session)).rejects.toMatchObject({ code: "spec-changed" });
  });
});

describe("supervisor launch failures and capacity", () => {
  const oneSlot = { maxConcurrentJobs: 1 };

  it("a definite pre-spawn failure terminalizes the job and releases capacity", async () => {
    const coordinator = await createCoordinator({ root: base });
    launcher.launch = async () => {
      throw new PreSpawnLaunchError("storage-unavailable", "supervisor entry missing");
    };

    await expect(coordinator.start(request({ limits: oneSlot }), session)).rejects.toBeInstanceOf(PreSpawnLaunchError);

    const jobs = await coordinator.repositories.jobs.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe("failed");

    launcher.launch = runningLaunch;
    const next = await coordinator.start(request({ limits: oneSlot }), session);
    expect(next.state).toBe("running");
  });

  it("an ambiguous launch failure keeps the reservation for reconciliation", async () => {
    const coordinator = await createCoordinator({ root: base });
    launcher.launch = async () => {
      throw new BackgroundJobError("storage-unavailable", "supervisor exited immediately");
    };

    await expect(coordinator.start(request({ limits: oneSlot }), session)).rejects.toMatchObject({
      code: "storage-unavailable",
    });

    const jobs = await coordinator.repositories.jobs.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe("accepted");

    launcher.launch = runningLaunch;
    await expect(coordinator.start(request({ limits: oneSlot }), session)).rejects.toMatchObject({
      code: "capacity-exceeded",
    });
  });
});
