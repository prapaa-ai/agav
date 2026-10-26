/**
 * Background jobs are a SEPARATE consent boundary from `run_command`.
 *
 * Unlike `run_command`, a background job runs OUTSIDE the OS sandbox and OUTSIDE
 * the turn timeout, as the full OS user. That is a strictly higher trust tier, so
 * it must not inherit `run_command`'s consent: it needs its own explicit gate.
 *
 * This suite proves the boundary against the REAL authorization service rather
 * than an unconditional fake. The fake coordinator runs the production
 * `createAuthorizationService(...).authorize("start", spec, session, {headless})`
 * decision (file-backed grant store in a temp dir) exactly as the real
 * coordinator does, so:
 *
 *   1. The tool is inert unless the user explicitly enabled it in config.
 *   2. Every launch it submits is isolation:none (unsandboxed) — a distinct,
 *      higher trust tier than a sandboxed run_command.
 *   3. Headless start/stop/schedule WRITE actions fail closed through the real
 *      authorization gate unless an explicit exact-spec grant exists.
 *   4. Background consent is exact-spec: an approval for one spec does not carry
 *      to a different command, and generic tool-approval cannot widen it.
 *   5. The headless flag and session policy are host-supplied, never model input.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorizationService } from "../background-jobs/authorization/service.js";
import type { ConsentRelevantSpec } from "../background-jobs/authorization/spec-hash.js";
import {
  BackgroundJobError,
  DEFAULT_RESOURCE_LIMITS,
  type CoordinatorClient,
  type JobSummary,
  type ScheduleRecord,
  type SessionPolicySnapshot,
  type StartJobRequest,
} from "../background-jobs/types.js";

let mockConfig: Record<string, unknown> = { backgroundJobsEnabled: true, permissionMode: "auto-accept" };
vi.mock("../config/config.js", () => ({ loadConfig: async () => mockConfig }));

// Real, file-backed authorization service shared by the fake coordinator.
const authRoot = mkdtempSync(join(tmpdir(), "agav-consent-auth-"));
const authorization = createAuthorizationService(authRoot);

const starts: StartJobRequest[] = [];
const createdSchedules: Array<{ cron: string; timezone: string; template: unknown }> = [];
const revoked: string[] = [];
let existingSchedules: ScheduleRecord[] = [];

function summary(jobId: string): JobSummary {
  return { jobId, requestId: "req-" + jobId, state: "running", stopState: "none" };
}

/** Mirror the coordinator's consent spec for a tool start request (isolation:none). */
function consentSpecFor(request: StartJobRequest): ConsentRelevantSpec {
  return {
    invocation: request.invocation,
    cwd: request.cwd,
    env: {},
    credentialRefs: [],
    isolation: request.isolation,
    ownershipScope: "unverified",
    limits: DEFAULT_RESOURCE_LIMITS,
    headless: request.headless ?? false,
  };
}

const fakeCoordinator: Partial<CoordinatorClient> = {
  // Delegate the start decision to the REAL authorization service, exactly as the
  // production coordinator does, so the headless gate / exact-spec grants are
  // genuinely exercised rather than rubber-stamped.
  async start(request: StartJobRequest, session: SessionPolicySnapshot): Promise<JobSummary> {
    const decision = await authorization.authorize("start", consentSpecFor(request), session, {
      headless: request.headless === true,
    });
    if (!decision.allowed) {
      throw new BackgroundJobError("authorization-denied", decision.reason ?? "not approved");
    }
    starts.push(request);
    return summary("job-1");
  },
  async list() { return []; },
  async poll() { return summary("job-1"); },
  async stop(): Promise<JobSummary> { return { ...summary("job-1"), state: "interrupted", stopState: "observed-stopped" }; },
};

const fakeScheduleEngine = {
  async createSchedule(opts: { cron: string; timezone: string; launchSpecTemplate: unknown; session: SessionPolicySnapshot }) {
    createdSchedules.push({ cron: opts.cron, timezone: opts.timezone, template: opts.launchSpecTemplate });
    return { scheduleId: "sched-1", cron: opts.cron, timezone: opts.timezone } as ScheduleRecord;
  },
  async listSchedules() { return existingSchedules; },
  async revokeSchedule(id: string) { revoked.push(id); },
};

vi.mock("../background-jobs-integration.js", () => ({
  getSharedCoordinator: async () => fakeCoordinator,
  getSharedScheduleEngine: async () => fakeScheduleEngine,
}));

const { backgroundJobTool } = await import("../tools/background-job.js");

beforeEach(() => {
  mockConfig = { backgroundJobsEnabled: true, permissionMode: "auto-accept" };
  starts.length = 0;
  createdSchedules.length = 0;
  revoked.length = 0;
  existingSchedules = [];
});
afterEach(() => vi.clearAllMocks());
afterAll(() => { try { rmSync(authRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("background jobs require explicit opt-in (consent gate #1)", () => {
  it("refuses every action when backgroundJobsEnabled is not true", async () => {
    mockConfig = { backgroundJobsEnabled: false, permissionMode: "auto-accept" };
    for (const action of ["start", "list", "poll", "stop", "schedule-create", "schedule-list", "schedule-revoke"]) {
      const result = await backgroundJobTool.execute({ action, command: "echo hi", jobId: "x", cron: "* * * * *", timezone: "UTC", scheduleId: "x" });
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/not enabled/i);
    }
    expect(starts).toHaveLength(0);
    expect(createdSchedules).toHaveLength(0);
  });

  it("stays inert even if the model omits backgroundJobsEnabled from config", async () => {
    mockConfig = { permissionMode: "auto-accept" };
    const result = await backgroundJobTool.execute({ action: "start", command: "echo hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not enabled/i);
    expect(starts).toHaveLength(0);
  });
});

describe("background launches are unsandboxed — a distinct trust tier (boundary #2)", () => {
  it("submits start requests with isolation backend 'none'", async () => {
    const result = await backgroundJobTool.execute({ action: "start", command: "echo hi" });
    expect(result.isError).toBe(false);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.isolation).toEqual({ backend: "none", required: false });
  });

  it("schedules launch templates are also isolation 'none'", async () => {
    const result = await backgroundJobTool.execute({ action: "schedule-create", command: "echo hi", cron: "* * * * *", timezone: "UTC" });
    expect(result.isError).toBe(false);
    expect(createdSchedules).toHaveLength(1);
    expect((createdSchedules[0]!.template as { isolation: unknown }).isolation).toEqual({ backend: "none", required: false });
  });
});

describe("headless mode fails closed through the REAL authorization gate (consent gate #3)", () => {
  // No interactive confirmation is possible in headless mode, so each WRITE
  // action must be refused unless an explicit grant for that exact action exists.
  const headlessCtx = (approved: string[] = []) => ({
    headless: true,
    backgroundPolicy: { permissionMode: "auto-accept", headlessApprovedActions: approved } as SessionPolicySnapshot,
  });

  it("denies 'start' even under auto-accept — the action that launches unsandboxed", async () => {
    // This is the key boundary: auto-accept must NOT let a headless start through.
    const result = await backgroundJobTool.execute({ action: "start", command: "echo hi" }, headlessCtx() as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/requires confirmation|not approved|applicable grant/i);
    expect(starts).toHaveLength(0);
  });

  it("allows a headless 'start' only once the action is explicitly approved for headless", async () => {
    // This asserts the ACTION-level headless gate (approving "start" lets the
    // action through). The stricter EXACT-SPEC guarantee — that a grant for one
    // command/cwd does not authorize a different one — is proven against the real
    // coordinator in background-job-consent-real-coordinator.test.ts, since under
    // auto-accept the authorization service mints a grant for whatever spec is
    // supplied and cannot demonstrate changed-spec rejection here.
    const result = await backgroundJobTool.execute({ action: "start", command: "echo hi" }, headlessCtx(["start"]) as never);
    expect(result.isError).toBe(false);
    expect(starts).toHaveLength(1);
  });

  it("denies 'stop' without an explicit grant", async () => {
    const result = await backgroundJobTool.execute({ action: "stop", jobId: "job-1" }, headlessCtx() as never);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/requires confirmation|not approved/i);
  });

  it("denies 'schedule-create' without an explicit grant", async () => {
    const result = await backgroundJobTool.execute({ action: "schedule-create", command: "echo hi", cron: "* * * * *", timezone: "UTC" }, headlessCtx() as never);
    expect(result.isError).toBe(true);
    expect(createdSchedules).toHaveLength(0);
  });

  it("denies 'schedule-revoke' of an existing schedule without an explicit grant", async () => {
    existingSchedules = [{ scheduleId: "sched-1", cron: "* * * * *", timezone: "UTC" } as ScheduleRecord];
    const result = await backgroundJobTool.execute({ action: "schedule-revoke", scheduleId: "sched-1" }, headlessCtx() as never);
    expect(result.isError).toBe(true);
    expect(revoked).toHaveLength(0);
  });

  it("allows a write action ONLY when its exact grant is present", async () => {
    const result = await backgroundJobTool.execute({ action: "stop", jobId: "job-1" }, headlessCtx(["stop"]) as never);
    expect(result.isError).toBe(false);
  });

  it("a grant for one action does not authorize a different action", async () => {
    // Granting 'stop' must not unlock 'schedule-create'.
    const result = await backgroundJobTool.execute(
      { action: "schedule-create", command: "echo hi", cron: "* * * * *", timezone: "UTC" },
      headlessCtx(["stop"]) as never,
    );
    expect(result.isError).toBe(true);
    expect(createdSchedules).toHaveLength(0);
  });

  it("keeps read-only actions available in headless mode", async () => {
    for (const action of ["list", "poll", "schedule-list"]) {
      const result = await backgroundJobTool.execute({ action, jobId: "job-1" }, headlessCtx() as never);
      expect(result.isError).toBe(false);
    }
  });
});

describe("background consent is exact-spec, not generic tool approval (boundary #4)", () => {
  it("an interactive-mode grant for one command does not authorize a different command", async () => {
    // Approve exactly one command via the real interactive confirm path (ask mode).
    const confirm = vi.fn(async () => true);
    const askCtx = {
      backgroundPolicy: {
        permissionMode: "ask",
        headlessApprovedActions: [],
        confirmBackgroundAction: confirm,
      } as SessionPolicySnapshot,
    };
    const approved = await backgroundJobTool.execute({ action: "start", command: "echo approved" }, askCtx as never);
    expect(approved.isError).toBe(false);
    expect(starts).toHaveLength(1);

    // A DIFFERENT command must ask again; if the user declines, it is refused and
    // never launched — a prior approval cannot be reused for a new spec.
    const decline = vi.fn(async () => false);
    const result = await backgroundJobTool.execute(
      { action: "start", command: "echo different" },
      { backgroundPolicy: { permissionMode: "ask", headlessApprovedActions: [], confirmBackgroundAction: decline } as SessionPolicySnapshot } as never,
    );
    expect(result.isError).toBe(true);
    expect(decline).toHaveBeenCalled();
    expect(starts).toHaveLength(1); // still just the first, approved command
  });

  it("reuses a grant for the SAME spec without asking again", async () => {
    const confirm = vi.fn(async () => true);
    const askCtx = {
      backgroundPolicy: { permissionMode: "ask", headlessApprovedActions: [], confirmBackgroundAction: confirm } as SessionPolicySnapshot,
    };
    const first = await backgroundJobTool.execute({ action: "start", command: "echo reuse" }, askCtx as never);
    expect(first.isError).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);

    // Identical spec: the existing grant covers it, so confirm is NOT called again.
    const confirmAgain = vi.fn(async () => true);
    const second = await backgroundJobTool.execute(
      { action: "start", command: "echo reuse" },
      { backgroundPolicy: { permissionMode: "ask", headlessApprovedActions: [], confirmBackgroundAction: confirmAgain } as SessionPolicySnapshot } as never,
    );
    expect(second.isError).toBe(false);
    expect(confirmAgain).not.toHaveBeenCalled();
    expect(starts).toHaveLength(2);
  });
});

describe("the consent boundary is host-governed, not model-governed (boundary #5)", () => {
  it("ignores a model attempt to self-declare headless=false in the input", async () => {
    // `headless` is only read from the host-supplied context; a field in the
    // model's tool input must have no effect on the gate.
    const result = await backgroundJobTool.execute(
      { action: "stop", jobId: "job-1", headless: false } as never,
      { headless: true, backgroundPolicy: { permissionMode: "auto-accept", headlessApprovedActions: [] } } as never,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/requires confirmation|not approved/i);
  });

  it("ignores a model attempt to self-declare headless=false on start", async () => {
    const result = await backgroundJobTool.execute(
      { action: "start", command: "echo hi", headless: false } as never,
      { headless: true, backgroundPolicy: { permissionMode: "auto-accept", headlessApprovedActions: [] } } as never,
    );
    expect(result.isError).toBe(true);
    expect(starts).toHaveLength(0);
  });

  it("marks the job's isolation as unrestricted so the confirmation UI can warn", async () => {
    // The describeBackgroundConfirmation path (used by the interactive gate) must
    // treat backend:none as unrestricted, keeping the separate boundary visible.
    const { describeBackgroundConfirmation } = await import("../components/background-confirmation.js");
    const info = describeBackgroundConfirmation("start", {
      invocation: { mode: "shell", interpreter: "posix-sh", commandText: "echo hi" },
      cwd: "/tmp",
      isolation: { backend: "none", required: false },
    } as never);
    expect(info.unrestricted).toBe(true);
    expect(info.isolation).toMatch(/NONE|unrestricted/i);
  });
});
