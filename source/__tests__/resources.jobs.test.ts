import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";
import type { ResourceAdapter, ResourceItem } from "../resources/types.js";
import { BackgroundJobError, type JobSummary } from "../background-jobs/types.js";

const mocks = vi.hoisted(() => ({
  coordinator: {
    list: vi.fn(),
    poll: vi.fn(),
    log: vi.fn(),
    stop: vi.fn(),
    capabilities: vi.fn(),
    abandonJob: vi.fn(),
  },
  engine: {
    listSchedules: vi.fn(),
    createSchedule: vi.fn(),
    revokeSchedule: vi.fn(),
    listRuns: vi.fn(),
    setScheduleEnabled: vi.fn(),
    deleteSchedule: vi.fn(),
  },
  props: undefined as undefined | { adapter: ResourceAdapter; height?: number; prompt?: string; actions: { key: string; label: string; run(item: ResourceItem | undefined): unknown }[] },
}));
vi.mock("../background-jobs-integration.js", () => ({
  getSharedCoordinator: async () => mocks.coordinator,
  getSharedScheduleEngine: async () => mocks.engine,
}));

const { CommandRegistry } = await import("../commands/registry.js");
const { createJobsAdapter, createJobSchedulesAdapter, stopJob, revokeSchedule, jobCapabilities, sortJobsNewestFirst } = await import("../resources/job-adapters.js");

const summary: JobSummary = {
  jobId: "0123456789abcdef",
  requestId: "req-1",
  state: "running",
  stopState: "none",
  startedAt: "2024-01-01T00:00:00Z",
};
const session = { permissionMode: "auto-accept" as const, headlessApprovedActions: [] };
const schedule = (enabled: boolean, pausedAt?: string) => ({
  scheduleId: "sched-0123456789",
  version: 1,
  cron: "0 9 * * *",
  timezone: "UTC",
  grantId: "g",
  enabled,
  ...(pausedAt ? { pausedAt } : {}),
  createdAt: "2024-01-01T00:00:00Z",
  launchSpecTemplate: { invocation: { mode: "shell", interpreter: "posix-sh", commandText: "npm test" }, cwd: "/repo" },
});

const caps = {
  platform: "linux", availableIsolationBackends: [], strongestOwnershipScope: "process-group",
  supportsGracefulApplicationShutdown: true, supportsDelegatedCgroup: false, nativeHelperAvailable: false, limitations: [],
};
const run = (requestId: string, job?: Partial<JobSummary>) => ({
  occurrence: { occurrenceId: `occ-${requestId}`, scheduleId: "sched-0123456789", occurrenceKey: "k", requestId, status: "dispatched", createdAt: "2024-01-02T09:00:00Z" },
  job: job ? { ...summary, requestId, ...job } : undefined,
});

// Defaults are re-applied every test so per-test overrides never leak.
beforeEach(() => {
  vi.clearAllMocks();
  mocks.engine.listSchedules.mockResolvedValue([]);
  mocks.engine.listRuns.mockResolvedValue([]);
});

describe("/job resource manager routing", () => {
  const context = (interactive: boolean, enabled = true, isLoading = false) => ({
    isLoading,
    config: { permissionMode: "auto-accept", backgroundJobsEnabled: enabled },
    setPickerActive: vi.fn(),
    showResourceTUI: interactive ? vi.fn((_kind, done) => done()) : undefined,
  } as unknown as CommandContext);

  it("opens the jobs manager through the interactive app hook", async () => {
    const ctx = context(true);
    expect(await new CommandRegistry().execute("/job", ctx)).toEqual({ type: "none" });
    expect(ctx.showResourceTUI).toHaveBeenCalledWith("jobs", expect.any(Function), false);
    expect(ctx.setPickerActive).toHaveBeenNthCalledWith(1, true);
    expect(ctx.setPickerActive).toHaveBeenLastCalledWith(false);
  });

  it("falls back to usage when headless or mid-turn", async () => {
    for (const ctx of [context(false), context(true, true, true)]) {
      expect(await new CommandRegistry().execute("/job", ctx)).toMatchObject({ type: "message", text: expect.stringContaining("Usage: /job") });
      expect(ctx.setPickerActive).not.toHaveBeenCalled();
    }
  });

  it("does not open the manager when background jobs are disabled", async () => {
    const ctx = context(true, false);
    expect(await new CommandRegistry().execute("/job", ctx)).toMatchObject({ type: "message", text: expect.stringContaining("not enabled") });
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
  });

  it("keeps /job list textual even in interactive mode", async () => {
    mocks.coordinator.list.mockResolvedValue([]);
    const ctx = context(true);
    expect(await new CommandRegistry().execute("/job list", ctx)).toEqual({ type: "message", text: "No background jobs found." });
    expect(ctx.showResourceTUI).not.toHaveBeenCalled();
  });
});

describe("jobs adapter", () => {
  it("lists jobs as resource items and inspects with summary plus full logs of both streams", async () => {
    mocks.coordinator.list.mockResolvedValue([summary]);
    mocks.coordinator.poll.mockResolvedValue(summary);
    mocks.coordinator.log.mockImplementation(async (_id: string, opts: { stream?: string }) =>
      opts.stream === "stdout" ? { text: "out line\n", truncated: true, cursor: "" } : { text: "  \n", truncated: false, cursor: "" });
    const adapter = createJobsAdapter();
    expect(adapter.inspectLabel).toBe("Details & logs");
    const [item] = await adapter.list();
    expect(item).toMatchObject({ id: summary.jobId, title: "01234567  running  · independent run" });
    expect(item!.description).toContain("exit -");
    expect(adapter.remove).toBeTypeOf("function");
    expect(item!.removable).toBe(false); // Running jobs are listed but cannot be deleted.
    expect(adapter.setEnabled).toBeUndefined();
    const detail = (await adapter.get(summary.jobId))!.detail;
    expect(mocks.coordinator.log).toHaveBeenCalledWith(summary.jobId, { maxBytes: 65536, stream: "stdout" });
    expect(mocks.coordinator.log).toHaveBeenCalledWith(summary.jobId, { maxBytes: 65536, stream: "stderr" });
    // Summary leads so the view, which opens at the top, shows it first.
    expect(detail.indexOf(`jobId: ${summary.jobId}`)).toBeLessThan(detail.indexOf("── stdout"));
    expect(detail).toContain("origin: independent run");
    expect(detail).toContain("── stdout (last 64 KB) ──\nout line");
    expect(detail).toContain("── stderr ──\n(no output captured)");
  });

  it("labels each job with the schedule that launched it, or as an independent run", async () => {
    const other = { ...summary, jobId: "fedcba9876543210", requestId: "req-2", startedAt: "2023-01-01T00:00:00Z" };
    mocks.coordinator.list.mockResolvedValue([summary, other]);
    mocks.coordinator.poll.mockResolvedValue(summary);
    mocks.coordinator.log.mockResolvedValue({ text: "", truncated: false, cursor: "" });
    mocks.engine.listSchedules.mockResolvedValue([schedule(true)]);
    mocks.engine.listRuns.mockResolvedValue([run("req-1", {})]);
    const adapter = createJobsAdapter();
    const [scheduled, independent] = await adapter.list();
    expect(mocks.engine.listRuns).toHaveBeenCalledWith("sched-0123456789");
    expect(scheduled!.title).toBe('01234567  running  · schedule "npm test" (0 9 * * *)');
    expect(scheduled!.detail).toContain("origin: schedule sched-0123456789");
    expect(independent!.title).toBe("fedcba98  running  · independent run");
    expect(independent!.detail).toContain("origin: independent run");
    expect((await adapter.get(summary.jobId))!.detail).toContain("origin: schedule sched-0123456789");
  });

  it("still lists jobs with an unknown origin when schedules cannot be loaded", async () => {
    mocks.coordinator.list.mockResolvedValue([summary]);
    mocks.engine.listSchedules.mockRejectedValue(new Error("store broken"));
    const [item] = await createJobsAdapter().list();
    expect(item!.title).toBe("01234567  running  · origin unknown");
    expect(item!.detail).toContain("origin: unknown");
  });

  it("sorts unstarted jobs first, then newest start first", () => {
    const at = (jobId: string, startedAt?: string): JobSummary => ({ ...summary, jobId, startedAt });
    const sorted = sortJobsNewestFirst([at("old", "2024-01-01T00:00:00Z"), at("pending"), at("new", "2024-03-01T00:00:00Z"), at("mid", "2024-02-01T00:00:00Z")]);
    expect(sorted.map((s) => s.jobId)).toEqual(["pending", "new", "mid", "old"]);
  });

  it("lists jobs newest first through the adapter", async () => {
    mocks.coordinator.list.mockResolvedValue([{ ...summary, jobId: "aaaaaaaaaa", startedAt: "2024-01-01T00:00:00Z" }, { ...summary, jobId: "bbbbbbbbbb", startedAt: "2024-05-01T00:00:00Z" }]);
    expect((await createJobsAdapter().list()).map((i) => i.id)).toEqual(["bbbbbbbbbb", "aaaaaaaaaa"]);
  });

  it("translates subsystem errors into the same messages as the text command", async () => {
    mocks.coordinator.poll.mockRejectedValue(new BackgroundJobError("not-found", "abc"));
    await expect(createJobsAdapter().get("abc")).rejects.toThrow("No matching background job was found: abc");
  });

  it("stops jobs with the session policy and reports capabilities", async () => {
    mocks.coordinator.stop.mockResolvedValue({ ...summary, stopState: "requested" });
    expect(await stopJob(summary.jobId, session)).toBe("Stop requested for 01234567 (state: running, stop: requested).");
    expect(mocks.coordinator.stop).toHaveBeenCalledWith(summary.jobId, session);
    mocks.coordinator.capabilities.mockResolvedValue(caps);
    expect(await jobCapabilities()).toContain("availableIsolationBackends: (none)");
  });
});

describe("jobs recovery visibility", () => {
  const audit = { abandonedAt: "2026-10-20T00:00:00Z", acknowledgement: "outcome-and-descendants-unverified" as const, previousState: "unknown" as const, previousNonce: "" };
  it("hides abandoned records by default without losing by-ID inspection or all-jobs access", async () => {
    const abandoned = { ...summary, state: "unknown" as const, abandonment: audit };
    mocks.coordinator.list.mockResolvedValue([abandoned]);
    mocks.coordinator.poll.mockResolvedValue(abandoned);
    mocks.coordinator.log.mockResolvedValue({ text: "", truncated: false });
    expect(await createJobsAdapter().list()).toEqual([]);
    const item = (await createJobsAdapter(true).list())[0]!;
    expect(item.title).toContain("[abandoned]");
    expect(item).toMatchObject({ removable: false, stoppable: false, abandonable: false });
    expect((await createJobsAdapter().get(summary.jobId))!.detail).toContain("abandonedAt:");
  });
  it.each(["unknown", "recovery-required"] as const)("offers abandonment, not stop/delete, for %s", async state => {
    mocks.coordinator.list.mockResolvedValue([{ ...summary, state }]);
    expect((await createJobsAdapter().list())[0]).toMatchObject({ abandonable: true, removable: false, stoppable: false });
  });
});

describe("job schedules adapter", () => {
  it("allows deleting inactive schedules but not enabled or revoked schedules", async () => {
    mocks.engine.listSchedules.mockResolvedValue([
      schedule(true),
      { ...schedule(false, "2024-02-01T00:00:00Z"), scheduleId: "paused" },
      { ...schedule(false), scheduleId: "revoked" },
    ]);
    const [active, paused, revoked] = await createJobSchedulesAdapter(session).list();
    expect(active).toMatchObject({ title: "npm test", enabled: true, removable: false });
    expect(active!.detail).toContain("Status: enabled");
    expect(paused).toMatchObject({ title: "npm test", enabled: false, removable: true });
    expect(paused!.detail).toContain("Status: paused since");
    expect(revoked).toMatchObject({ title: "npm test [revoked]", enabled: undefined, removable: true });
    expect(revoked!.detail).toContain("Status: revoked");
  });

  it("shows the last run by its job, or never", async () => {
    mocks.engine.listSchedules.mockResolvedValue([schedule(true), { ...schedule(true), scheduleId: "idle" }]);
    mocks.engine.listRuns.mockImplementation(async (id: string) =>
      id === "idle" ? [] : [run("req-2", { jobId: "abcdef0123456789", state: "completed", exitCode: 0 }), run("req-1")]);
    const adapter = createJobSchedulesAdapter(session);
    const [withRuns, idle] = await adapter.list();
    expect(withRuns!.description).toMatch(/^0 9 \* \* \* · UTC · last run .*abcdef01  completed exit 0$/);
    expect(withRuns!.detail).toContain("Recent runs (2 of 2):");
    expect(withRuns!.detail).toContain("dispatched");
    expect(idle!.description).toBe("0 9 * * * · UTC · last run never");
    expect(idle!.detail).toContain("No runs yet.");
    expect((await adapter.get("idle"))!.id).toBe("idle");
  });

  it("pauses and resumes through the engine with the session policy", async () => {
    mocks.engine.setScheduleEnabled.mockResolvedValue(schedule(false, "2024-02-01T00:00:00Z"));
    const adapter = createJobSchedulesAdapter(session);
    await adapter.setEnabled!("sched-0123456789", false);
    expect(mocks.engine.setScheduleEnabled).toHaveBeenLastCalledWith("sched-0123456789", false, session);
    await adapter.setEnabled!("sched-0123456789", true);
    expect(mocks.engine.setScheduleEnabled).toHaveBeenLastCalledWith("sched-0123456789", true, session);
  });

  it("translates a denied resume into the confirmation message", async () => {
    mocks.engine.setScheduleEnabled.mockRejectedValue(new BackgroundJobError("authorization-denied", "deny-writes"));
    await expect(createJobSchedulesAdapter(session).setEnabled!("sched-0123456789", true))
      .rejects.toThrow("This action requires confirmation; it was not approved. (deny-writes)");
  });

  it("creates from form fields and revokes with the session policy", async () => {
    mocks.engine.createSchedule.mockResolvedValue(schedule(true));
    const adapter = createJobSchedulesAdapter(session);
    expect(adapter.fields!.map((f) => f.name)).toEqual(["cron", "timezone", "command"]);
    expect(await adapter.create!({ cron: " 0 9 * * * ", timezone: " UTC ", command: "npm test" })).toBe("Created schedule sched-0123456789.");
    expect(mocks.engine.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      cron: "0 9 * * *", timezone: "UTC", session,
      launchSpecTemplate: expect.objectContaining({ invocation: expect.objectContaining({ mode: "shell", commandText: "npm test" }) }),
    }));
    await revokeSchedule("sched-0123456789", session);
    expect(mocks.engine.revokeSchedule).toHaveBeenCalledWith("sched-0123456789", session);
  });
});

describe("JobsTUI", () => {
  async function mountJobsTUI(height = 16) {
    vi.resetModules();
    vi.doMock("../components/resource-manager.js", () => ({
      ResourceManager: (props: NonNullable<typeof mocks.props>) => { mocks.props = props; return null; },
    }));
    const { default: render } = await import("../ink/render.js");
    const { JobsTUI } = await import("../components/jobs-tui.js");
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 100, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
    const instance = render(h(JobsTUI, { onExit: vi.fn(), permissionMode: "ask", height }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    const settle = async () => { await new Promise((r) => setTimeout(r, 50)); await instance.waitUntilRenderFlush(); };
    const key = async (text: string) => { stdin.emit("data", Buffer.from(text)); await settle(); };
    const action = (k: string) => mocks.props!.actions.find((a) => a.key === k)!;
    const cleanup = () => { instance.unmount(); vi.doUnmock("../components/resource-manager.js"); };
    await instance.waitUntilRenderFlush();
    return { settle, key, action, cleanup };
  }
  const jobItem = { id: summary.jobId, title: "", description: "", detail: "" };

  it("passes the app's available height to the resource manager", async () => {
    const ui = await mountJobsTUI(16);
    try {
      expect(mocks.props!.height).toBe(16);
    } finally {
      ui.cleanup();
    }
  });

  it("switches between jobs and schedules and offers stop only for jobs", async () => {
    const ui = await mountJobsTUI();
    try {
      expect(mocks.props!.adapter.title).toBe("Background jobs");
      // Logs live in the ENTER/i detail view; no separate key duplicates it.
      expect(mocks.props!.actions.map((a) => a.key)).toEqual(["Tab", "x", "a", "h", "c"]);
      expect(mocks.props!.prompt).toBeUndefined();

      mocks.coordinator.stop.mockResolvedValue(summary);
      const stop = ui.action("x");
      expect(await stop.run(undefined)).toBeUndefined();
      expect(mocks.coordinator.stop).not.toHaveBeenCalled();
      await stop.run(jobItem);
      expect(mocks.coordinator.stop).toHaveBeenCalledWith(summary.jobId, expect.objectContaining({
        permissionMode: "ask", headlessApprovedActions: [], confirmBackgroundAction: expect.any(Function),
      }));

      ui.action("Tab").run(undefined);
      await ui.settle();
      expect(mocks.props!.adapter.title).toBe("Background job schedules");
      expect(mocks.props!.actions.map((a) => a.key)).toEqual(["Tab", "x", "c"]);
    } finally {
      ui.cleanup();
    }
  });

  it("opens capabilities in the detail view", async () => {
    const ui = await mountJobsTUI();
    try {
      mocks.coordinator.capabilities.mockResolvedValue(caps);
      const capsResult = await ui.action("c").run(undefined);
      expect(typeof capsResult).toBe("object");
      expect(capsResult).toEqual({ detail: expect.stringContaining("availableIsolationBackends: (none)") });
    } finally {
      ui.cleanup();
    }
  });

  it("asks in the manager before stopping and answers with y or n", async () => {
    const ui = await mountJobsTUI();
    const spec = {
      invocation: { mode: "shell" as const, interpreter: "posix-sh" as const, commandText: "sleep 30" },
      cwd: "/repo", env: {}, credentialRefs: [], isolation: { backend: "none" as const, required: false },
      ownershipScope: "unverified" as const, limits: { maxOutputBytes: 1 }, headless: false,
    };
    const answers: boolean[] = [];
    mocks.coordinator.stop.mockImplementation(async (_id: string, s: import("../background-jobs/types.js").SessionPolicySnapshot) => {
      answers.push(await s.confirmBackgroundAction!("stop", spec as never));
      return summary;
    });
    try {
      const first = ui.action("x").run(jobItem) as Promise<unknown>;
      await ui.settle();
      expect(mocks.props!.prompt).toBe("Stop running job: sleep 30? y: Approve · n/ESC: Deny");
      await ui.key("q"); // unrelated keys leave the prompt pending
      expect(mocks.props!.prompt).toContain("Stop running job: sleep 30?");
      await ui.key("y");
      await first;
      expect(answers).toEqual([true]);
      expect(mocks.props!.prompt).toBeUndefined();

      const second = ui.action("x").run(jobItem) as Promise<unknown>;
      await ui.settle();
      expect(mocks.props!.prompt).toContain("Stop running job: sleep 30?");
      await ui.key("n");
      await second;
      expect(answers).toEqual([true, false]);
      expect(mocks.props!.prompt).toBeUndefined();
    } finally {
      ui.cleanup();
    }
  });

  it("denies a pending confirmation when the manager unmounts", async () => {
    const ui = await mountJobsTUI();
    let answer: Promise<boolean> | undefined;
    mocks.engine.setScheduleEnabled.mockImplementation((_id: string, _enabled: boolean, s: import("../background-jobs/types.js").SessionPolicySnapshot) => {
      answer = s.confirmBackgroundAction!("schedule-create", { invocation: { mode: "shell", interpreter: "posix-sh", commandText: "npm test" } } as never);
      return new Promise(() => {});
    });
    try {
      ui.action("Tab").run(undefined);
      await ui.settle();
      void mocks.props!.adapter.setEnabled!("sched-0123456789", true);
      await ui.settle();
      expect(mocks.engine.setScheduleEnabled).toHaveBeenCalledWith("sched-0123456789", true, expect.objectContaining({ permissionMode: "ask" }));
      expect(mocks.props!.prompt).toBe("Allow schedule to launch: npm test? y: Approve · n/ESC: Deny");
    } finally {
      ui.cleanup();
    }
    await expect(answer).resolves.toBe(false);
  });
});
