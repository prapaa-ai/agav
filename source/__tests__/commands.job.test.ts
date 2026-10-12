import { fixtureCommand, killWindowsFixtureSupervisor } from "./background-job-fixtures.js";
/**
 * T16 — Tests for the `/job` slash command.
 *
 * Same real-coordinator approach as `tools.background-job.test.ts`: import
 * the coordinator from compiled `build/` output so the real detached
 * supervisor actually launches. Run `npx tsc -p tsconfig.json` first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandContext } from "../commands/types.js";

const execFileAsync = promisify(execFile);

/**
 * See the matching helper/comment in tools.background-job.test.ts: T11's
 * supervisor never self-exits, and `coordinator/launcher.ts` doesn't
 * persist the supervisor's own OS pid anywhere, so test cleanup matches on
 * the jobId in the supervisor's argv instead. Test-hygiene only.
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

const { jobCommand } = await import("../commands/job.js");
const { __setSharedCoordinatorForTests } = await import("../background-jobs-integration.js");

async function importBuiltCoordinatorModule(): Promise<typeof import("../background-jobs/coordinator/service.js")> {
  const url = new URL("../../build/background-jobs/coordinator/service.js", import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

function createContext(configOverrides: Record<string, unknown> = {}): CommandContext {
  return {
    conversation: {} as any,
    config: { permissionMode: "auto-accept", backgroundJobsEnabled: true, ...configOverrides } as any,
    setModel: vi.fn(),
    setProvider: vi.fn(),
    setEffort: vi.fn(),
    clearMessages: vi.fn(),
    refreshPlan: vi.fn(),
    showStatus: vi.fn(),
    saveSession: vi.fn(),
    refreshDisplay: vi.fn(),
    loadSession: vi.fn(),
    activateSession: vi.fn(),
    renameSession: vi.fn(),
    exit: vi.fn(),
    getDebugState: vi.fn(),
    submit: vi.fn(),
    handleSubmit: vi.fn(),
    toolRegistry: {} as any,
    addTokenUsage: vi.fn(),
    setRunningSkill: vi.fn(),
    setPickerActive: vi.fn(),
    suspendTerminal: vi.fn(() => vi.fn()),
    showAgentsTUI: vi.fn(),
    showSkillsTUI: vi.fn(),
  };
}

function messageText(result: Awaited<ReturnType<typeof jobCommand.execute>>): string {
  expect(result.type).toBe("message");
  return result.type === "message" ? result.text : "";
}

let root: string;
let coordinator: Awaited<ReturnType<typeof import("../background-jobs/coordinator/service.js").createCoordinator>>;
const startedJobIds: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-bg-cmd-test-"));
  const { createCoordinator } = await importBuiltCoordinatorModule();
  coordinator = await createCoordinator({ root });
  __setSharedCoordinatorForTests(coordinator as any);
  startedJobIds.length = 0;
});

afterEach(async () => {
  // See the matching comment in tools.background-job.test.ts: T11's
  // supervisor never self-exits after a terminal job state, so tests that
  // spawn real supervisors must explicitly kill the process in cleanup to
  // avoid leaking one long-lived Node process per test run. Test-hygiene
  // only; no production file is affected.
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

async function startRealJob(command: string): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const summary = await coordinator.start(
    {
      requestId: randomUUID(),
      invocation: { mode: "shell", interpreter: process.platform === "win32" ? "cmd" : "posix-sh", commandText: command },
      cwd: process.cwd(),
      isolation: { backend: "none", required: false },
    },
    { permissionMode: "auto-accept", headlessApprovedActions: [] },
  );
  startedJobIds.push(summary.jobId);
  return summary.jobId;
}

describe("/job — opt-in gate", () => {
  it("blocks when backgroundJobsEnabled is false", async () => {
    const context = createContext({ backgroundJobsEnabled: false });
    const result = await jobCommand.execute("list", context);
    expect(messageText(result)).toContain("not enabled");
  });

  it("blocks when backgroundJobsEnabled is absent", async () => {
    const context = createContext({ backgroundJobsEnabled: undefined });
    const result = await jobCommand.execute("capabilities", context);
    expect(messageText(result)).toContain("not enabled");
  });
});

describe("/job list", () => {
  it("reports plainly when there are no jobs", async () => {
    const result = await jobCommand.execute("list", createContext());
    expect(messageText(result)).toBe("No background jobs found.");
  });

  it("shows a started job", async () => {
    const jobId = await startRealJob(fixtureCommand("cmd-test done", 200));
    const result = await jobCommand.execute("list", createContext());
    expect(messageText(result)).toContain(jobId.slice(0, 8));
  }, 15000);
});

describe("/job poll", () => {
  it("requires an id", async () => {
    const result = await jobCommand.execute("poll", createContext());
    expect(messageText(result)).toContain("Usage: /job poll <id>");
  });

  it("shows job state", async () => {
    const jobId = await startRealJob(fixtureCommand("poll-test", 200));
    const result = await jobCommand.execute(`poll ${jobId}`, createContext());
    expect(messageText(result)).toContain(`jobId: ${jobId}`);
  }, 15000);
});

describe("/job log", () => {
  it("requires an id", async () => {
    const result = await jobCommand.execute("log", createContext());
    expect(messageText(result)).toContain("Usage: /job log <id>");
  });

  it("shows captured output once the job has produced some", async () => {
    const jobId = await startRealJob(fixtureCommand("log-test-output"));

    const deadline = Date.now() + 15000;
    let text = "";
    while (Date.now() < deadline) {
      const result = await jobCommand.execute(`log ${jobId}`, createContext());
      text = messageText(result);
      if (text.includes("log-test-output")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(text).toContain("log-test-output");
  }, 20000);
});

describe("/job stop", () => {
  it("requires an id", async () => {
    const result = await jobCommand.execute("stop", createContext());
    expect(messageText(result)).toContain("Usage: /job stop <id>");
  });

  it("reports the exact supported stop outcome without claiming Windows shell descendants stopped", async () => {
    const jobId = await startRealJob(fixtureCommand("bounded", 10000));

    const runningDeadline = Date.now() + 10000;
    while (Date.now() < runningDeadline) {
      const result = await jobCommand.execute(`poll ${jobId}`, createContext());
      if (messageText(result).includes("state: running")) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const expectedState = process.platform === "win32" ? "unknown" : "interrupted";
    const stopResult = await jobCommand.execute(`stop ${jobId}`, createContext());
    expect(stopResult.type).toBe("message");

    const deadline = Date.now() + 15000;
    let finalText = "";
    while (Date.now() < deadline) {
      const result = await jobCommand.execute(`poll ${jobId}`, createContext());
      finalText = messageText(result);
      if (finalText.includes(`state: ${expectedState}`)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(finalText).toContain(`state: ${expectedState}`);
    if (process.platform === "win32") {
      expect(finalText).toContain("stopState: acknowledged");
      expect(finalText).not.toContain("stopState: observed-stopped");
    }
  }, 30000);
});

describe("/job capabilities", () => {
  it("prints a capability report", async () => {
    const result = await jobCommand.execute("capabilities", createContext());
    const text = messageText(result);
    expect(text).toContain("platform:");
    expect(text).toContain("availableIsolationBackends:");
  });
});

describe("/job unknown action", () => {
  it("shows usage for unrecognized actions", async () => {
    const result = await jobCommand.execute("bogus-action", createContext());
    expect(messageText(result)).toContain("Unknown action");
  });

  it("shows usage for no args", async () => {
    const result = await jobCommand.execute("", createContext());
    expect(messageText(result)).toContain("Usage: /job");
  });
});
