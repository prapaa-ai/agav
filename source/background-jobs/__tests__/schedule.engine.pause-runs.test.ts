/**
 * Pause/resume (`setScheduleEnabled`) and run history (`listRuns`) for the schedule engine.
 *
 * Same setup as schedule.engine.test.ts: real temp-dir repositories and authorization
 * service, with a fake CoordinatorClient that only implements `start()`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_RESOURCE_LIMITS,
  isScheduleRevoked,
  type CoordinatorClient,
  type JobRecord,
  type JobSummary,
  type LaunchSpec,
  type SessionPolicySnapshot,
  type StartJobRequest,
} from "../types.js";
import { createFileRepositories } from "../storage/repositories.js";
import { createAuthorizationService } from "../authorization/service.js";
import { createScheduleEngine } from "../schedule/engine.js";

const autoAcceptSession: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };
const denyWritesSession: SessionPolicySnapshot = { permissionMode: "deny-writes", headlessApprovedActions: [] };
const DUE = new Date("2024-06-01T09:00:00Z");

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

function createFakeCoordinator() {
  const calls: StartJobRequest[] = [];
  return {
    calls,
    async start(request: StartJobRequest): Promise<JobSummary> {
      calls.push(request);
      return { jobId: randomUUID(), requestId: request.requestId, state: "running", stopState: "none" };
    },
  };
}

function jobRecord(requestId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: randomUUID(),
    requestId,
    specHash: "hash",
    protocolVersion: 1,
    state: "completed",
    stopState: "none",
    nonce: "nonce",
    exitCode: 0,
    ...overrides,
  };
}

describe("schedule engine pause, resume and runs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agav-schedule-pause-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function setup() {
    const fakeCoordinator = createFakeCoordinator();
    const repositories = createFileRepositories(tempDir);
    const engine = createScheduleEngine({
      repositories,
      coordinator: fakeCoordinator as unknown as CoordinatorClient,
      authorizationService: createAuthorizationService(tempDir),
      root: tempDir,
    });
    const schedule = await engine.createSchedule({
      cron: "0 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });
    return { fakeCoordinator, repositories, engine, schedule };
  }

  it("pausing sets pausedAt without revoking, and resuming clears it", async () => {
    const { engine, repositories, schedule } = await setup();

    const paused = await engine.setScheduleEnabled(schedule.scheduleId, false, autoAcceptSession);
    expect(paused.enabled).toBe(false);
    expect(typeof paused.pausedAt).toBe("string");
    expect(isScheduleRevoked(paused)).toBe(false);
    expect(await repositories.schedules.get(schedule.scheduleId)).toMatchObject({ enabled: false, pausedAt: paused.pausedAt });

    const resumed = await engine.setScheduleEnabled(schedule.scheduleId, true, autoAcceptSession);
    expect(resumed.enabled).toBe(true);
    expect(resumed.pausedAt).toBeUndefined();
    const stored = await repositories.schedules.get(schedule.scheduleId);
    expect(stored?.enabled).toBe(true);
    expect(stored?.pausedAt).toBeUndefined();
  });

  it("returns the schedule unchanged when the state already matches", async () => {
    const { engine, schedule } = await setup();
    expect(await engine.setScheduleEnabled(schedule.scheduleId, true, denyWritesSession)).toMatchObject({ enabled: true });
  });

  it("a paused schedule is not evaluated or dispatched, and dispatches again after resume", async () => {
    const { engine, fakeCoordinator, schedule } = await setup();
    await engine.setScheduleEnabled(schedule.scheduleId, false, autoAcceptSession);

    const results = await engine.evaluateOnce({ nowUtc: DUE, connectedSessions: [] });
    expect(results.some((r) => r.scheduleId === schedule.scheduleId)).toBe(false);
    expect(fakeCoordinator.calls).toHaveLength(0);

    await engine.setScheduleEnabled(schedule.scheduleId, true, autoAcceptSession);
    const after = await engine.evaluateOnce({ nowUtc: DUE, connectedSessions: [] });
    expect(after.find((r) => r.scheduleId === schedule.scheduleId)?.outcome).toBe("dispatched");
    expect(fakeCoordinator.calls).toHaveLength(1);
  });

  it("deny-writes never blocks pausing itself, but pausing still needs a grant like revoke", async () => {
    const { engine, repositories, schedule } = await setup();
    const denied = await engine.setScheduleEnabled(schedule.scheduleId, false, denyWritesSession).catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: "authorization-denied" });
    expect((denied as Error).message).not.toMatch(/deny-writes/);
    expect((await repositories.schedules.get(schedule.scheduleId))?.enabled).toBe(true);
  });

  it("deny-writes may pause but not resume", async () => {
    const { engine, repositories, schedule } = await setup();
    // Mint a schedule-revoke grant for this schedule's spec (pausing is gated like revocation).
    await engine.setScheduleEnabled(schedule.scheduleId, false, autoAcceptSession);
    await engine.setScheduleEnabled(schedule.scheduleId, true, autoAcceptSession);

    await engine.setScheduleEnabled(schedule.scheduleId, false, denyWritesSession);
    const paused = await repositories.schedules.get(schedule.scheduleId);
    expect(paused?.enabled).toBe(false);

    await expect(engine.setScheduleEnabled(schedule.scheduleId, true, denyWritesSession))
      .rejects.toMatchObject({ code: "authorization-denied" });
    expect(await repositories.schedules.get(schedule.scheduleId)).toMatchObject({ enabled: false, pausedAt: paused?.pausedAt });
  });

  it("a revoked schedule cannot be resumed", async () => {
    const { engine, repositories, schedule } = await setup();
    await engine.revokeSchedule(schedule.scheduleId, autoAcceptSession);
    const revoked = await repositories.schedules.get(schedule.scheduleId);
    expect(isScheduleRevoked(revoked!)).toBe(true);

    await expect(engine.setScheduleEnabled(schedule.scheduleId, true, autoAcceptSession))
      .rejects.toMatchObject({ code: "authorization-denied" });
    await expect(engine.setScheduleEnabled(schedule.scheduleId, false, autoAcceptSession))
      .rejects.toMatchObject({ code: "authorization-denied" });
    expect(isScheduleRevoked((await repositories.schedules.get(schedule.scheduleId))!)).toBe(true);
  });

  it("revoking a paused schedule makes it permanently revoked", async () => {
    const { engine, repositories, schedule } = await setup();
    await engine.setScheduleEnabled(schedule.scheduleId, false, autoAcceptSession);
    await engine.revokeSchedule(schedule.scheduleId, autoAcceptSession);

    const stored = await repositories.schedules.get(schedule.scheduleId);
    expect(stored?.enabled).toBe(false);
    expect(stored?.pausedAt).toBeUndefined();
    expect(isScheduleRevoked(stored!)).toBe(true);
    await expect(engine.setScheduleEnabled(schedule.scheduleId, true, autoAcceptSession))
      .rejects.toMatchObject({ code: "authorization-denied" });
  });

  it("throws not-found for an unknown schedule", async () => {
    const { engine } = await setup();
    await expect(engine.setScheduleEnabled("missing-schedule", false, autoAcceptSession))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("lists no runs for a schedule that never fired", async () => {
    const { engine, schedule } = await setup();
    expect(await engine.listRuns(schedule.scheduleId)).toEqual([]);
  });

  it("lists runs newest first, joined to their job when one exists", async () => {
    const { engine, repositories, schedule } = await setup();
    const occurrence = (n: number, createdAt: string) => ({
      occurrenceId: `occ-${n}`,
      scheduleId: schedule.scheduleId,
      occurrenceKey: `key-${n}`,
      requestId: `req-${n}`,
      status: "dispatched" as const,
      createdAt,
    });
    await repositories.occurrences.reserve(occurrence(1, "2024-06-01T09:00:00.000Z"));
    await repositories.occurrences.reserve({ ...occurrence(2, "2024-06-03T09:00:00.000Z"), status: "recovery-required", reason: "boom" });
    await repositories.occurrences.reserve(occurrence(3, "2024-06-02T09:00:00.000Z"));
    const job1 = jobRecord("req-1");
    const job3 = jobRecord("req-3", { state: "running", exitCode: undefined });
    await repositories.jobs.create(job1);
    await repositories.jobs.create(job3);
    await repositories.jobs.create(jobRecord("unrelated-request"));

    const runs = await engine.listRuns(schedule.scheduleId);
    expect(runs.map((r) => r.occurrence.occurrenceId)).toEqual(["occ-2", "occ-3", "occ-1"]);
    expect(runs[0]!.job).toBeUndefined();
    expect(runs[0]!.occurrence).toMatchObject({ status: "recovery-required", reason: "boom" });
    expect(runs[1]!.job).toMatchObject({ jobId: job3.jobId, state: "running" });
    expect(runs[2]!.job).toMatchObject({ jobId: job1.jobId, exitCode: 0 });
  });

  it("includes occurrences dispatched by evaluateOnce and scopes runs to their schedule", async () => {
    const { engine, fakeCoordinator, schedule } = await setup();
    const other = await engine.createSchedule({
      cron: "30 9 * * *",
      timezone: "UTC",
      launchSpecTemplate: buildLaunchSpecTemplate(),
      session: autoAcceptSession,
    });
    await engine.evaluateOnce({ nowUtc: DUE, connectedSessions: [] });
    expect(fakeCoordinator.calls).toHaveLength(1);

    const runs = await engine.listRuns(schedule.scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.occurrence).toMatchObject({ status: "dispatched", requestId: fakeCoordinator.calls[0]!.requestId });
    // The fake coordinator does not persist job records, so there is nothing to join.
    expect(runs[0]!.job).toBeUndefined();
    expect(await engine.listRuns(other.scheduleId)).toEqual([]);
  });
});
