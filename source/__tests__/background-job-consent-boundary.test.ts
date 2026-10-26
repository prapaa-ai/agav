/**
 * Background jobs are a SEPARATE consent boundary from `run_command`.
 *
 * Unlike `run_command`, a background job runs OUTSIDE the OS sandbox and OUTSIDE
 * the turn timeout, as the full OS user. That is a strictly higher trust tier, so
 * it must not inherit `run_command`'s consent: it needs its own explicit gate.
 * These tests prove the invariants of that boundary at the tool layer, using a
 * fake coordinator/schedule engine so no real supervisor process is spawned:
 *
 *   1. The tool is inert unless the user explicitly enabled it in config.
 *   2. Every launch it submits is isolation:none (unsandboxed) — the tool never
 *      launders a request through the run_command sandbox.
 *   3. In headless mode (no interactive confirmation possible) every WRITE action
 *      fails closed unless an explicit grant for that exact action is present;
 *      read-only actions stay available.
 *   4. The headless flag and session policy are host-supplied, never model input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CoordinatorClient,
  JobSummary,
  ScheduleRecord,
  SessionPolicySnapshot,
  StartJobRequest,
} from "../background-jobs/types.js";

let mockConfig: Record<string, unknown> = { backgroundJobsEnabled: true, permissionMode: "auto-accept" };
vi.mock("../config/config.js", () => ({ loadConfig: async () => mockConfig }));

const starts: StartJobRequest[] = [];
const createdSchedules: Array<{ cron: string; timezone: string; template: unknown }> = [];
const revoked: string[] = [];
let existingSchedules: ScheduleRecord[] = [];

function summary(jobId: string): JobSummary {
  return { jobId, requestId: "req-" + jobId, state: "running", stopState: "none" };
}

const fakeCoordinator: Partial<CoordinatorClient> = {
  async start(request: StartJobRequest) {
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

describe("headless mode fails closed on write actions (consent gate #3)", () => {
  // No interactive confirmation is possible in headless mode, so each WRITE
  // action must be refused unless an explicit grant for that exact action exists.
  const headlessCtx = (approved: string[] = []) => ({
    headless: true,
    backgroundPolicy: { permissionMode: "auto-accept", headlessApprovedActions: approved } as SessionPolicySnapshot,
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

describe("the consent boundary is host-governed, not model-governed", () => {
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
