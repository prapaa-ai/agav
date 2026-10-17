/**
 * T16 — Tests for the `run_background_job` tool's `schedule-create` /
 * `schedule-list` / `schedule-revoke` actions.
 *
 * Follows the exact pattern of `tools.background-job.test.ts`: the REAL
 * coordinator (and, transitively, the real schedule engine built on top of
 * it) is imported from the COMPILED `build/background-jobs/...` output,
 * since `packaging/locator.ts` resolves the supervisor entry relative to
 * its own `import.meta.url` and only the `build/` tree has the compiled
 * sibling `supervisor/entry.js` next to it. Run `npx tsc -p tsconfig.json`
 * (a full build) before running this file.
 *
 * `loadConfig` is mocked so tests can flip `backgroundJobsEnabled` and
 * `permissionMode` without touching real config files on disk.
 *
 * Note: creating a schedule in this delivery never dispatches a job (no
 * evaluation timer exists yet), so there is no `startedJobIds` array or
 * supervisor-process cleanup loop needed here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Kill the real detached SUPERVISOR process (not the workload) started for
 * `jobId`. `coordinator/launcher.ts` currently discards the
 * `DetachedLaunchResult` from `launchDetachedSupervisor`, so the
 * supervisor's own OS pid is never persisted anywhere a test (or any other
 * external caller) could look it up directly — only the WORKLOAD's pid ends
 * up in `JobRecord.identity` (see `supervisor/lifecycle.ts`). Combined with
 * T11's deliberate "supervisor never self-exits" design, this means nothing
 * in the current production code path ever terminates a job's supervisor
 * process. That is correct intended behavior for a real install (a human
 * eventually reaps these via OS session/process-manager mechanisms, or a
 * future cleanup/export flow per solution.md §9), but it is a genuine
 * process leak across repeated TEST runs on one machine, so test cleanup
 * here matches on the jobId appearing in the supervisor's own argv (which
 * is stable and unique per job) rather than relying on a pid this layer was
 * never given. This is test-hygiene only; no production file is changed.
 *
 * Kept here (unused by any test in this file, since schedules never
 * dispatch a job in this delivery) purely to mirror the sibling test
 * file's exact structure in case a future test needs it.
 */
async function killSupervisorProcessForJob(jobId: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", `background-jobs/supervisor/entry.js ${jobId} `]);
    for (const pid of stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  } catch {
    // pgrep exits non-zero when no match is found; nothing to clean up.
  }
}
void killSupervisorProcessForJob;

let mockConfig: Record<string, unknown> = { backgroundJobsEnabled: false, permissionMode: "ask" };

vi.mock("../config/config.js", () => ({
  loadConfig: async () => mockConfig,
}));

const { backgroundJobTool } = await import("../tools/background-job.js");
const { __setSharedCoordinatorForTests } = await import("../background-jobs-integration.js");

async function importBuiltCoordinatorModule(): Promise<typeof import("../background-jobs/coordinator/service.js")> {
  const url = new URL("../../build/background-jobs/coordinator/service.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

let root: string;
let coordinator: Awaited<ReturnType<typeof import("../background-jobs/coordinator/service.js").createCoordinator>>;

beforeEach(async () => {
  mockConfig = { backgroundJobsEnabled: true, permissionMode: "auto-accept" };
  root = await mkdtemp(join(tmpdir(), "agav-bg-tool-schedule-test-"));
  const { createCoordinator } = await importBuiltCoordinatorModule();
  coordinator = await createCoordinator({ root });
  __setSharedCoordinatorForTests(coordinator as any);
});

afterEach(async () => {
  __setSharedCoordinatorForTests(null);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 20000);

describe("run_background_job — schedule actions opt-in gate", () => {
  it("blocks schedule-create/schedule-list/schedule-revoke when backgroundJobsEnabled is false", async () => {
    mockConfig = { backgroundJobsEnabled: false, permissionMode: "ask" };
    for (const action of ["schedule-create", "schedule-list", "schedule-revoke"] as const) {
      const result = await backgroundJobTool.execute({
        action,
        command: "echo hi",
        cron: "0 9 * * *",
        timezone: "UTC",
        scheduleId: "whatever",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("backgroundJobsEnabled");
    }
  });
});

describe("run_background_job — schedule-create / schedule-list", () => {
  it("creates a schedule with a valid cron+timezone+command and it appears in schedule-list", async () => {
    const createResult = await backgroundJobTool.execute({
      action: "schedule-create",
      command: "echo scheduled-hello",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    expect(createResult.isError).toBe(false);
    expect(createResult.output).toContain("Created schedule");

    const listResult = await backgroundJobTool.execute({ action: "schedule-list" });
    expect(listResult.isError).toBe(false);
    expect(listResult.output).toContain('cron: "0 9 * * *"');
    expect(listResult.output).toContain("timezone: UTC");
  });

  it("rejects an invalid cron string with a clear error, not a throw", async () => {
    const result = await backgroundJobTool.execute({
      action: "schedule-create",
      command: "echo hi",
      cron: "not a cron",
      timezone: "UTC",
    });
    expect(result.isError).toBe(true);
  });

  it("requires command/cron/timezone", async () => {
    const r1 = await backgroundJobTool.execute({ action: "schedule-create", cron: "0 9 * * *", timezone: "UTC" });
    expect(r1.isError).toBe(true);
    const r2 = await backgroundJobTool.execute({ action: "schedule-create", command: "echo hi", timezone: "UTC" });
    expect(r2.isError).toBe(true);
    const r3 = await backgroundJobTool.execute({ action: "schedule-create", command: "echo hi", cron: "0 9 * * *" });
    expect(r3.isError).toBe(true);
  });

  it("schedule-list reports plainly when there are no schedules", async () => {
    const result = await backgroundJobTool.execute({ action: "schedule-list" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("No schedules found.");
  });

  it("does not dispatch any job merely by creating a schedule (no evaluation timer exists in this delivery)", async () => {
    await backgroundJobTool.execute({
      action: "schedule-create",
      command: "echo should-not-run",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    const listResult = await backgroundJobTool.execute({ action: "list" });
    expect(listResult.output).toBe("No background jobs found.");
  });
});

describe("run_background_job — schedule-revoke", () => {
  it("revokes an existing schedule and schedule-list shows it disabled", async () => {
    const createResult = await backgroundJobTool.execute({
      action: "schedule-create",
      command: "echo hi",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    const idMatch = /Created schedule (\S+) /.exec(createResult.output);
    expect(idMatch).not.toBeNull();
    const scheduleId = idMatch![1]!;

    const revokeResult = await backgroundJobTool.execute({ action: "schedule-revoke", scheduleId });
    expect(revokeResult.isError).toBe(false);
    expect(revokeResult.output).toContain("Revoked schedule");

    const listResult = await backgroundJobTool.execute({ action: "schedule-list" });
    expect(listResult.output).toContain("[disabled]");
  });

  it("returns a clear error for an unknown scheduleId", async () => {
    const result = await backgroundJobTool.execute({ action: "schedule-revoke", scheduleId: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("no schedule found");
  });

  it("requires scheduleId", async () => {
    const result = await backgroundJobTool.execute({ action: "schedule-revoke" });
    expect(result.isError).toBe(true);
  });
});
