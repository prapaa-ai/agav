import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../main.js";
import { loadConfig, type AgavConfig } from "../config/config.js";
import { BackgroundJobError, type JobSummary } from "../background-jobs/types.js";

const { list, poll } = vi.hoisted(() => ({
  list: vi.fn<() => Promise<JobSummary[]>>(),
  poll: vi.fn<(id: string) => Promise<JobSummary>>(),
}));
vi.mock("../background-jobs-integration.js", () => ({ getSharedCoordinator: async () => ({ list, poll }) }));
vi.mock("../config/config.js", async original => ({ ...await original<typeof import("../config/config.js")>(), loadConfig: vi.fn() }));
vi.mock("../config/history.js", () => ({ listSessions: async () => [{ id: "previous-session" }] }));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: async () => ({}) }));
vi.mock("../config/launch-state.js", () => ({ consumeChangelogDisplay: async () => false }));
vi.mock("../config/session-state.js", () => ({ markCleanExit: async () => {}, markCleanExitSync: () => {} }));
vi.mock("../ink/index.js", () => ({ render: () => ({ waitUntilExit: async () => {} }) }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: async () => {} }));
vi.mock("../utils/git.js", () => ({ getGitContext: async () => null }));
vi.mock("../utils/terminal-keyboard.js", () => ({ detectKittyKeyboard: async () => false }));

const config: AgavConfig = {
  provider: "ollama", model: "test", systemPrompt: "test", effort: "low", maxTokens: 1000,
  maxIterations: 5, errorRetries: 0, permissionMode: "ask", backgroundJobsEnabled: true,
};
const originalArgv = process.argv;
const exited = new Error("process exited");
const stderr = vi.fn(() => true);
const job = (jobId: string, state: JobSummary["state"]): JobSummary => ({ jobId, state, requestId: jobId, stopState: "none" });
const abandonment: JobSummary["abandonment"] = {
  abandonedAt: "2026-01-01", acknowledgement: "outcome-and-descendants-unverified", previousState: "unknown", previousNonce: "",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadConfig).mockResolvedValue({ ...config });
  process.argv = [process.execPath, "agav"];
  vi.spyOn(process, "exit").mockImplementation(() => { throw exited; });
  vi.spyOn(process, "stdout", "get").mockReturnValue({ write: vi.fn(() => true) } as never);
  vi.spyOn(process, "stderr", "get").mockReturnValue({ write: stderr } as never);
  vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as never);
  vi.spyOn(process, "on").mockImplementation(() => process);
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

async function exitOutput() {
  await expect(main()).rejects.toBe(exited);
  expect(process.exit).toHaveBeenCalledWith(0);
  return stderr.mock.calls.join("");
}

describe("background jobs in the interactive exit hint", () => {
  it("separates active and unverified jobs and omits finished and abandoned records", async () => {
    const summaries = [job("live-job", "running"), job("lost-job", "running"), job("recover-job", "recovery-required"),
      job("just-finished-job", "running"), job("finished-job", "failed"),
      { ...job("abandoned-job", "unknown"), abandonment }, job("abandoned-after-list", "unknown")];
    list.mockResolvedValue(summaries);
    poll.mockImplementation(async id => {
      if (id === "lost-job") return job(id, "unknown");
      if (id === "just-finished-job") return job(id, "completed");
      if (id === "abandoned-after-list") return { ...job(id, "unknown"), abandonment };
      return summaries.find(summary => summary.jobId === id)!;
    });

    const output = await exitOutput();
    expect(output).toContain("To resume: agav --resume previous-session");
    expect(output).toContain("Active background jobs: live-job  (inspect with /job)");
    expect(output).toContain("Unverified background jobs: lost-job, recover-job  (inspect with /job)");
    for (const id of ["finished-job", "just-finished-job", "abandoned-job", "abandoned-after-list"]) {
      expect(output).not.toContain(id);
    }
    expect(poll).not.toHaveBeenCalledWith("abandoned-job");
    expect(poll).not.toHaveBeenCalledWith("finished-job");
  });

  it("reports a failed poll as unverified and skips a job removed since listing", async () => {
    list.mockResolvedValue([job("unreachable-job", "running"), job("removed-job", "unknown")]);
    poll.mockRejectedValueOnce(new Error("poll failed"));
    poll.mockRejectedValueOnce(new BackgroundJobError("not-found", "job removed"));

    const output = await exitOutput();
    expect(output).toContain("Unverified background jobs: unreachable-job  (inspect with /job)");
    expect(output).not.toContain("Active background jobs:");
    expect(output).not.toContain("removed-job");
  });

  it("keeps the resume hint even when background jobs are disabled", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ ...config, backgroundJobsEnabled: false });
    const output = await exitOutput();
    expect(output).toContain("To resume: agav --resume previous-session");
    expect(output).not.toContain("background jobs:");
    expect(list).not.toHaveBeenCalled();
  });
});
