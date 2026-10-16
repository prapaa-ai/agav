/**
 * WP-07 (plan item 0.8) — schedule dispatch forwards the template's `env` and
 * `limits` to `coordinator.start`, without disturbing consent hashes.
 *
 * Real temp-dir repositories + real authorization service, fake coordinator
 * capturing `start()` input (same pattern as schedule.engine.test.ts). The
 * captured request is then fed through the real `normalizeLaunchSpec` exactly as
 * `coordinator/service.ts start()` does, to show the values reach the LaunchSpec.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_RESOURCE_LIMITS,
  type CoordinatorClient,
  type JobSummary,
  type LaunchSpec,
  type SessionPolicySnapshot,
  type StartJobRequest,
} from "../types.js";
import { createFileRepositories } from "../storage/repositories.js";
import { createAuthorizationService } from "../authorization/service.js";
import { hashLaunchSpecForConsent } from "../authorization/spec-hash.js";
import { createGrantStore } from "../authorization/grant-store.js";
import { normalizeLaunchSpec } from "../launch-spec/normalize.js";
import { createScheduleEngine } from "../schedule/engine.js";

const autoAcceptSession: SessionPolicySnapshot = { permissionMode: "auto-accept", headlessApprovedActions: [] };

/** Mirrors how template creators build templates today (env: {}, default limits). */
function existingStyleTemplate(): Omit<LaunchSpec, "requestId" | "createdAt"> {
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
  const fake = {
    calls,
    async start(request: StartJobRequest, _session: SessionPolicySnapshot): Promise<JobSummary> {
      calls.push(request);
      return { jobId: randomUUID(), requestId: request.requestId, state: "running", stopState: "none" };
    },
  };
  return fake;
}

/** Same normalization call shape as coordinator/service.ts start(). */
function normalizeLikeCoordinator(request: StartJobRequest, withTemplateFields: boolean) {
  return normalizeLaunchSpec({
    requestId: request.requestId,
    invocation: request.invocation,
    cwd: request.cwd,
    platform: "linux",
    isolation: request.isolation,
    ownershipScope: "process-group",
    envInherit: request.envInherit,
    env: withTemplateFields ? request.env : undefined,
    limits: withTemplateFields ? request.limits : undefined,
    headless: request.headless,
    canonicalizeCwd: async (p) => p,
  });
}

function stripInstanceFields(spec: LaunchSpec): Omit<LaunchSpec, "requestId" | "createdAt"> {
  const { requestId: _r, createdAt: _c, ...rest } = spec;
  return rest;
}

describe("schedule engine — template env/limits dispatch (WP-07)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agav-schedule-template-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function buildEngine(fake: ReturnType<typeof createFakeCoordinator>) {
    const repositories = createFileRepositories(tempDir);
    const authorizationService = createAuthorizationService(tempDir);
    const engine = createScheduleEngine({
      repositories,
      coordinator: fake as unknown as CoordinatorClient,
      authorizationService,
      root: tempDir,
    });
    return { repositories, authorizationService, engine };
  }

  it("existing-style schedule still revalidates, keeps its grant hash, and dispatches", async () => {
    const fake = createFakeCoordinator();
    const { engine, authorizationService } = buildEngine(fake);
    const schedule = await engine.createSchedule({
      cron: "* * * * *",
      timezone: "UTC",
      launchSpecTemplate: existingStyleTemplate(),
      session: autoAcceptSession,
    });

    // Grant hash covers the template exactly as createSchedule persisted it,
    // including the effective environment resolved before consent.
    expect(schedule.launchSpecTemplate.env).toMatchObject({ PATH: expect.any(String) });
    const expectedHash = hashLaunchSpecForConsent({
      ...schedule.launchSpecTemplate,
      recurrence: { scheduleId: schedule.scheduleId, scheduleVersion: 1, cron: "* * * * *", timezone: "UTC" },
    });
    const grant = await createGrantStore(tempDir).get(schedule.grantId);
    expect(grant?.specHash).toBe(expectedHash);

    const revalidated = await authorizationService.revalidateBeforeDispatch(schedule.grantId, schedule.launchSpecTemplate);
    expect(revalidated.allowed).toBe(true);

    const results = await engine.evaluateOnce({ nowUtc: new Date("2024-06-01T12:00:30Z"), connectedSessions: [] });
    expect(results).toEqual([{ scheduleId: schedule.scheduleId, outcome: "dispatched" }]);
    expect(fake.calls).toHaveLength(1);
    const request = fake.calls[0]!;
    expect(request.env).toEqual(schedule.launchSpecTemplate.env);
    expect(request.limits).toEqual(DEFAULT_RESOURCE_LIMITS);
    expect(request.headless).toBeUndefined();

    // Grant still revalidates after dispatch (stored template unchanged).
    const after = await authorizationService.revalidateBeforeDispatch(schedule.grantId, schedule.launchSpecTemplate);
    expect(after.allowed).toBe(true);
    expect(after.grant?.specHash).toBe(expectedHash);

    // Per-job start consent hash is identical with or without the forwarded
    // fields for an existing-style template.
    const withFields = await normalizeLikeCoordinator(request, true);
    const withoutFields = await normalizeLikeCoordinator(request, false);
    expect(hashLaunchSpecForConsent(stripInstanceFields(withFields))).toBe(
      hashLaunchSpecForConsent(stripInstanceFields(withoutFields)),
    );
  });

  it("non-default template env and limits reach the start request and the launched spec", async () => {
    const fake = createFakeCoordinator();
    const { engine } = buildEngine(fake);
    const limits = { ...DEFAULT_RESOURCE_LIMITS, maxConcurrentJobs: 9 };
    const schedule = await engine.createSchedule({
      cron: "* * * * *",
      timezone: "UTC",
      launchSpecTemplate: { ...existingStyleTemplate(), env: { FOO: "bar" }, limits },
      session: autoAcceptSession,
    });

    const results = await engine.evaluateOnce({ nowUtc: new Date("2024-06-01T12:00:30Z"), connectedSessions: [] });
    expect(results[0]?.outcome).toBe("dispatched");
    const request = fake.calls[0]!;
    expect(request.env).toMatchObject({ FOO: "bar", PATH: expect.any(String) });
    expect(request.env).toEqual(schedule.launchSpecTemplate.env);
    expect(request.limits).toEqual(limits);

    const spec = await normalizeLikeCoordinator(request, true);
    expect(spec.env.FOO).toBe("bar");
    expect(spec.limits.maxConcurrentJobs).toBe(9);
    expect(spec.limits).toEqual(limits);
  });
});
