/**
 * T15 — `schedule/engine.ts` tests.
 *
 * Uses a REAL temp directory + real `createFileRepositories` (storage/repositories.ts,
 * T05) + real `createAuthorizationService` (authorization/service.ts, T08), but a FAKE
 * `CoordinatorClient` built inline below. A fake coordinator is appropriate here because
 * this suite exercises SCHEDULING logic only (cron due-detection, overlap/duplicate
 * prevention, restrictive-policy suppression, grant revalidation, capacity-failure
 * handling) — not real process launching, which is already covered end-to-end by T14's
 * own `coordinator.service.test.ts` (which requires a full `tsc` build and spawns real
 * `/bin/sh` child processes; out of scope for this file).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
import { createScheduleEngine } from "../schedule/engine.js";

const askSession: SessionPolicySnapshot = { permissionMode: "ask", headlessApprovedActions: [] };
const autoAcceptSession: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };
const denyWritesSession: SessionPolicySnapshot = { permissionMode: "deny-writes", headlessApprovedActions: [] };

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

/**
 * Fake coordinator: records every `start()` call and either resolves a fake
 * `JobSummary` or throws `BackgroundJobError("capacity-exceeded", ...)` depending on a
 * test-controlled flag. Only `start()` is implemented for real; the rest throw, since
 * `evaluateOnce` never calls them.
 */
function createFakeCoordinator() {
  const calls: StartJobRequest[] = [];
  let shouldThrowCapacity = false;
  const fake = {
    calls,
    setShouldThrowCapacity(value: boolean): void {
      shouldThrowCapacity = value;
    },
    async start(request: StartJobRequest, _session: SessionPolicySnapshot): Promise<JobSummary> {
      calls.push(request);
      if (shouldThrowCapacity) {
        throw new BackgroundJobError("capacity-exceeded", "fake limit reached");
      }
      return {
        jobId: randomUUID(),
        requestId: request.requestId,
        state: "running",
        stopState: "none",
      };
    },
    async list(): Promise<JobSummary[]> {
      throw new Error("not implemented in fake");
    },
    async poll(): Promise<JobSummary> {
      throw new Error("not implemented in fake");
    },
    async log(): Promise<never> {
      throw new Error("not implemented in fake");
    },
    async wait(): Promise<JobSummary> {
      throw new Error("not implemented in fake");
    },
    async stop(): Promise<JobSummary> {
      throw new Error("not implemented in fake");
    },
    async cleanup(): Promise<void> {
      throw new Error("not implemented in fake");
    },
    async capabilities(): Promise<never> {
      throw new Error("not implemented in fake");
    },
  };
  return fake;
}

describe("schedule engine", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agav-schedule-engine-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function buildEngine(fakeCoordinator: ReturnType<typeof createFakeCoordinator>) {
    const repositories = createFileRepositories(tempDir);
    const authorizationService = createAuthorizationService(tempDir);
    const engine = createScheduleEngine({
      repositories,
      coordinator: fakeCoordinator as unknown as CoordinatorClient,
      authorizationService,
      root: tempDir,
    });
    return { repositories, authorizationService, engine };
  }

  it.each([
    ["0 3 * * *", "2024-03-10T07:00:00Z"],
    ["0 2 * * *", "2024-11-03T07:00:00Z"],
    ["30 1 * * *", "2024-11-03T05:30:00Z"],
  ])("dispatches %s on the DST transition day at %s", async (cron, due) => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine, repositories } = buildEngine(fakeCoordinator);
    const schedule = await engine.createSchedule({
      cron, timezone: "America/New_York",
      launchSpecTemplate: buildLaunchSpecTemplate(), session: autoAcceptSession,
    });
    const results = await engine.evaluateOnce({ nowUtc: new Date(due), connectedSessions: [] });
    expect(results.find((r) => r.scheduleId === schedule.scheduleId)?.outcome).toBe("dispatched");
    expect(fakeCoordinator.calls).toHaveLength(1);
    const occurrences = await repositories.occurrences.listForSchedule(schedule.scheduleId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("dispatched");
    if (cron === "30 1 * * *") {
      await engine.evaluateOnce({ nowUtc: new Date("2024-11-03T06:30:00Z"), connectedSessions: [] });
      expect(fakeCoordinator.calls).toHaveLength(1);
      expect(await repositories.occurrences.listForSchedule(schedule.scheduleId)).toHaveLength(1);
    }
  });

  it("createSchedule under 'ask' mode with no prior grant throws authorization-denied", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine } = buildEngine(fakeCoordinator);

    await expect(
      engine.createSchedule({
        cron: "0 9 * * *",
        timezone: "UTC",
        launchSpecTemplate: buildLaunchSpecTemplate(),
        session: askSession,
      }),
    ).rejects.toMatchObject({ code: "authorization-denied" });
  });

  it("createSchedule under 'auto-accept' succeeds and the schedule is listed", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine } = buildEngine(fakeCoordinator);

    const record = await engine.createSchedule({
      cron: "0 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });

    expect(record.enabled).toBe(true);
    const all = await engine.listSchedules();
    expect(all.some((s) => s.scheduleId === record.scheduleId)).toBe(true);
  });

  it("evaluateOnce reports no-occurrence-due before the trigger time and does not dispatch", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine } = buildEngine(fakeCoordinator);

    const record = await engine.createSchedule({
      cron: "0 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });

    const results = await engine.evaluateOnce({
      nowUtc: new Date("2024-06-01T00:00:00Z"),
      connectedSessions: [],
    });

    const entry = results.find((r) => r.scheduleId === record.scheduleId);
    expect(entry?.outcome).toBe("no-occurrence-due");
    expect(fakeCoordinator.calls.length).toBe(0);
  });

  it("evaluateOnce dispatches exactly once at the due instant and does not double-dispatch on a repeat call", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine } = buildEngine(fakeCoordinator);

    const record = await engine.createSchedule({
      cron: "0 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });

    const dueNow = new Date("2024-06-01T09:00:00Z");

    const firstResults = await engine.evaluateOnce({ nowUtc: dueNow, connectedSessions: [] });
    const firstEntry = firstResults.find((r) => r.scheduleId === record.scheduleId);
    expect(firstEntry?.outcome).toBe("dispatched");
    expect(fakeCoordinator.calls.length).toBe(1);

    const secondResults = await engine.evaluateOnce({ nowUtc: dueNow, connectedSessions: [] });
    const secondEntry = secondResults.find((r) => r.scheduleId === record.scheduleId);
    expect(secondEntry?.outcome).toBe("skipped-overlap");
    expect(fakeCoordinator.calls.length).toBe(1);
  });

  it("a connected deny-writes session suppresses dispatch without reserving, and a later eligible slot still dispatches", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine, repositories } = buildEngine(fakeCoordinator);

    const record = await engine.createSchedule({
      cron: "0 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });

    const day1Due = new Date("2024-06-01T09:00:00Z");
    const suppressedResults = await engine.evaluateOnce({
      nowUtc: day1Due,
      connectedSessions: [denyWritesSession],
    });
    const suppressedEntry = suppressedResults.find((r) => r.scheduleId === record.scheduleId);
    expect(suppressedEntry?.outcome).toBe("skipped-restrictive-policy");
    expect(fakeCoordinator.calls.length).toBe(0);

    const occurrencesAfterSuppression = await repositories.occurrences.listForSchedule(record.scheduleId);
    expect(occurrencesAfterSuppression.length).toBe(0);

    const day2Due = new Date("2024-06-02T09:00:00Z");
    const dispatchedResults = await engine.evaluateOnce({
      nowUtc: day2Due,
      connectedSessions: [],
    });
    const dispatchedEntry = dispatchedResults.find((r) => r.scheduleId === record.scheduleId);
    expect(dispatchedEntry?.outcome).toBe("dispatched");
    expect(fakeCoordinator.calls.length).toBe(1);
  });

  it("revokeSchedule removes the schedule from future evaluation entirely", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine } = buildEngine(fakeCoordinator);

    const record = await engine.createSchedule({
      cron: "0 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });

    await engine.revokeSchedule(record.scheduleId, autoAcceptSession);

    const results = await engine.evaluateOnce({
      nowUtc: new Date("2024-06-01T09:00:00Z"),
      connectedSessions: [],
    });

    expect(results.some((r) => r.scheduleId === record.scheduleId)).toBe(false);
    expect(fakeCoordinator.calls.length).toBe(0);
  });

  it("a capacity-exceeded dispatch failure marks the occurrence recovery-required and is never retried", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const { engine, repositories } = buildEngine(fakeCoordinator);

    const record = await engine.createSchedule({
      cron: "0 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });

    fakeCoordinator.setShouldThrowCapacity(true);

    const dueNow = new Date("2024-06-01T09:00:00Z");
    const firstResults = await engine.evaluateOnce({ nowUtc: dueNow, connectedSessions: [] });
    const firstEntry = firstResults.find((r) => r.scheduleId === record.scheduleId);
    expect(firstEntry?.outcome).toBe("skipped-capacity");
    expect(fakeCoordinator.calls.length).toBe(1);

    const occurrences = await repositories.occurrences.listForSchedule(record.scheduleId);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0]?.status).toBe("recovery-required");

    const secondResults = await engine.evaluateOnce({ nowUtc: dueNow, connectedSessions: [] });
    const secondEntry = secondResults.find((r) => r.scheduleId === record.scheduleId);
    expect(secondEntry?.outcome).toBe("skipped-overlap");
    expect(fakeCoordinator.calls.length).toBe(1);
  });
});
