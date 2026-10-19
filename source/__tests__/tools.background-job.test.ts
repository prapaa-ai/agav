import { fixtureCommand, killWindowsFixtureSupervisor } from "./background-job-fixtures.js";
/**
 * T16 — Tests for the manual `run_background_job` tool.
 *
 * Per the project convention established in
 * `source/background-jobs/__tests__/coordinator.service.test.ts`, exercising
 * the REAL coordinator (real detached supervisor process, real jobs
 * directory) requires importing the coordinator from the COMPILED
 * `build/background-jobs/...` output, since `packaging/locator.ts` resolves
 * the supervisor entry relative to its own `import.meta.url` and only the
 * `build/` tree has the compiled sibling `supervisor/entry.js` next to it.
 * Run `npx tsc -p tsconfig.json` (a full build) before running this file.
 *
 * `loadConfig` is mocked so tests can flip `backgroundJobsEnabled` and
 * `permissionMode` without touching real config files on disk.
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
 */
async function killSupervisorProcessForJob(jobId: string): Promise<void> {
  if (process.platform === "win32") return killWindowsFixtureSupervisor(jobId);
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
const startedJobIds: string[] = [];

beforeEach(async () => {
  mockConfig = { backgroundJobsEnabled: true, permissionMode: "auto-accept" };
  root = await mkdtemp(join(tmpdir(), "agav-bg-tool-test-"));
  const { createCoordinator } = await importBuiltCoordinatorModule();
  coordinator = await createCoordinator({ root });
  __setSharedCoordinatorForTests(coordinator as any);
  startedJobIds.length = 0;
});

afterEach(async () => {
  // T11's supervisor process intentionally never self-exits, even once its
  // job reaches a terminal state (it stays alive to serve poll/log requests
  // indefinitely — "the supervisor decides its own lifetime", not tied to
  // any parent). `coordinator.stop()` only requests the WORKLOAD stop; it
  // does not terminate the supervisor process itself. Tests that spawn real
  // supervisors must therefore explicitly kill the supervisor process in
  // cleanup, or every test run leaks one long-lived Node process per job.
  // This is test-hygiene code only — it does not change any production
  // behavior or file (supervisors legitimately outliving the test process
  // is correct production behavior; only leaving them running forever in a
  // CI/test loop is the problem this cleanup addresses).
  for (const jobId of startedJobIds) {
    try {
      const summary = await coordinator.poll(jobId);
      if (summary.state === "running" || summary.state === "starting" || summary.state === "accepted") {
        await coordinator.stop(jobId, { permissionMode: "auto-accept", headlessApprovedActions: [] });
      }
    } catch {
      // best-effort
    }
    await killSupervisorProcessForJob(jobId);
  }
  __setSharedCoordinatorForTests(null);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}, 20000);

function extractJobId(output: string): string {
  const match = /Started background job (\S+) /.exec(output);
  if (!match) throw new Error(`Could not find jobId in output: ${output}`);
  return match[1]!;
}

describe("run_background_job — opt-in gate", () => {
  it("blocks every action when backgroundJobsEnabled is false", async () => {
    mockConfig = { backgroundJobsEnabled: false, permissionMode: "ask" };

    for (const action of ["start", "list", "poll", "log", "wait", "stop"] as const) {
      const result = await backgroundJobTool.execute({ action, command: "echo hi", jobId: "whatever" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("backgroundJobsEnabled");
    }
  });

  it("blocks every action when backgroundJobsEnabled is absent (undefined)", async () => {
    mockConfig = { permissionMode: "ask" };

    const result = await backgroundJobTool.execute({ action: "list" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not enabled");
  });
});

describe("run_background_job — start/poll/log/list happy path", () => {
  it("starts a quick job, polls it to completion, reads its log, and sees it in list()", async () => {
    const startResult = await backgroundJobTool.execute({
      action: "start",
      command: fixtureCommand("hello-from-tool done", 200),
    });
    expect(startResult.isError).toBe(false);
    expect(startResult.output).toContain("Started background job");
    expect(startResult.output).toContain("run_background_job action=poll jobId=");

    const jobId = extractJobId(startResult.output);
    startedJobIds.push(jobId);

    let pollResult = await backgroundJobTool.execute({ action: "poll", jobId });
    expect(pollResult.isError).toBe(false);
    expect(pollResult.output).toContain(`jobId: ${jobId}`);

    // Poll until terminal (bounded loop; real process, real timing).
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      pollResult = await backgroundJobTool.execute({ action: "poll", jobId });
      if (pollResult.output.includes("state: completed") || pollResult.output.includes("state: failed")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(pollResult.output).toContain("state: completed");

    const logResult = await backgroundJobTool.execute({ action: "log", jobId });
    expect(logResult.isError).toBe(false);
    expect(logResult.output).toContain("hello-from-tool");
    expect(logResult.output).toContain("done");

    const listResult = await backgroundJobTool.execute({ action: "list" });
    expect(listResult.isError).toBe(false);
    expect(listResult.output).toContain(jobId.slice(0, 8));
  }, 20000);

  it("start requires a command", async () => {
    const result = await backgroundJobTool.execute({ action: "start" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command");
  });

  it("list reports plainly when there are no jobs", async () => {
    const result = await backgroundJobTool.execute({ action: "list" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("No background jobs found.");
  });
});

describe("run_background_job — wait", () => {
  it("wait() blocks until the job is terminal and reports completion", async () => {
    const startResult = await backgroundJobTool.execute({
      action: "start",
      command: fixtureCommand("waited", 300),
    });
    const jobId = extractJobId(startResult.output);
    startedJobIds.push(jobId);

    const waitResult = await backgroundJobTool.execute({ action: "wait", jobId });
    expect(waitResult.isError).toBe(false);
    expect(waitResult.output).toContain("state: completed");
  }, 20000);

  it("wait() is cancellable via the tool's own AbortSignal and leaves the job running", async () => {
    const startResult = await backgroundJobTool.execute({
      action: "start",
      command: fixtureCommand("should-not-print-yet", 10000),
    });
    const jobId = extractJobId(startResult.output);
    startedJobIds.push(jobId);

    // Let it actually get to "running" before cancelling the wait.
    const runningDeadline = Date.now() + 10000;
    while (Date.now() < runningDeadline) {
      const poll = await backgroundJobTool.execute({ action: "poll", jobId });
      if (poll.output.includes("state: running")) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const waitStart = Date.now();
    const waitResult = await backgroundJobTool.execute({ action: "wait", jobId }, { signal: controller.signal });
    const waitDuration = Date.now() - waitStart;

    expect(waitDuration).toBeLessThan(8000);
    expect(waitResult.isError).toBe(false);
    expect(waitResult.output).not.toContain("state: completed");
    expect(waitResult.output).not.toContain("state: failed");

    const poll = await backgroundJobTool.execute({ action: "poll", jobId });
    expect(poll.output.match(/state: (running|starting|accepted)/)).not.toBeNull();
  }, 20000);
});

describe("run_background_job — stop", () => {
  it("reports the exact supported stop outcome without claiming Windows shell descendants stopped", async () => {
    const startResult = await backgroundJobTool.execute({ action: "start", command: fixtureCommand("bounded", 10000) });
    const jobId = extractJobId(startResult.output);
    startedJobIds.push(jobId);

    const runningDeadline = Date.now() + 10000;
    while (Date.now() < runningDeadline) {
      const poll = await backgroundJobTool.execute({ action: "poll", jobId });
      if (poll.output.includes("state: running")) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const expectedState = process.platform === "win32" ? "unknown" : "interrupted";
    const stopResult = await backgroundJobTool.execute({ action: "stop", jobId });
    expect(stopResult.isError).toBe(false);

    const deadline = Date.now() + 15000;
    let finalOutput = "";
    while (Date.now() < deadline) {
      const poll = await backgroundJobTool.execute({ action: "poll", jobId });
      finalOutput = poll.output;
      if (finalOutput.includes(`state: ${expectedState}`)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(finalOutput).toContain(`state: ${expectedState}`);
    if (process.platform === "win32") {
      expect(finalOutput).toContain("stopState: acknowledged");
      expect(finalOutput).not.toContain("stopState: observed-stopped");
    }
  }, 30000);
});

describe("run_background_job — missing jobId", () => {
  it.each(["poll", "log", "wait", "stop"] as const)(
    "returns a clear error (not a throw) when jobId is missing for action:%s",
    async (action) => {
      const result = await backgroundJobTool.execute({ action });
      expect(result.isError).toBe(true);
      expect(result.output.toLowerCase()).toContain("jobid");
    },
  );
});
