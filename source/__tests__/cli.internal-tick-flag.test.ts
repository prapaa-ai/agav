import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_TICK_INTERNAL_FLAG,
  INTERNAL_FLAGS,
  SUPERVISOR_INTERNAL_FLAG,
  getBackgroundTickArgs,
} from "../background-jobs/packaging/manifest.js";

const mocks = vi.hoisted(() => ({ main: vi.fn(), runSupervisor: vi.fn(), runJobCli: vi.fn() }));
// Importing main.js is what loads Ink and renders the UI; the tick path must never touch it.
vi.mock("../main.js", () => ({ main: mocks.main, hasStartupFinished: () => true }));
vi.mock("../background-jobs/supervisor/entry.js", () => ({ runSupervisor: mocks.runSupervisor }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

async function runCli(...args: string[]): Promise<void> {
  process.argv = [process.execPath, "agav", ...args];
  vi.resetModules();
  // cli.tsx runs its dispatch as top-level await; awaiting the import awaits dispatch.
  await import("../cli.js");
}

const TICK_ENTRY = "../cli/job-cli.js";
function mockTickEntry(factory: () => Record<string, unknown>): void {
  vi.doMock(TICK_ENTRY, factory);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.doUnmock(TICK_ENTRY);
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("internal background tick flag", () => {
  it("is registered in the packaging manifest alongside the supervisor flag", () => {
    expect(BACKGROUND_TICK_INTERNAL_FLAG).toBe("--internal-background-jobs-tick");
    expect(BACKGROUND_TICK_INTERNAL_FLAG).not.toBe(SUPERVISOR_INTERNAL_FLAG);
    expect(INTERNAL_FLAGS).toEqual([SUPERVISOR_INTERNAL_FLAG, BACKGROUND_TICK_INTERNAL_FLAG, "--internal-workflow-runner"]);
    expect(getBackgroundTickArgs()).toEqual([BACKGROUND_TICK_INTERNAL_FLAG]);
    expect(getBackgroundTickArgs("/opt/agav/build/cli.js")).toEqual(["/opt/agav/build/cli.js", BACKGROUND_TICK_INTERNAL_FLAG]);
  });

  it("routes to the headless tick entry without rendering the UI", async () => {
    mocks.runJobCli.mockResolvedValue(0);
    mockTickEntry(() => ({ runJobCli: mocks.runJobCli }));
    await runCli(BACKGROUND_TICK_INTERNAL_FLAG, "--extra");
    expect(mocks.runJobCli).toHaveBeenCalledWith(["tick", "--extra"]);
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.runSupervisor).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("propagates a non-zero tick exit code", async () => {
    mocks.runJobCli.mockResolvedValue(1);
    mockTickEntry(() => ({ runJobCli: mocks.runJobCli }));
    await runCli(BACKGROUND_TICK_INTERNAL_FLAG);
    expect(mocks.runJobCli).toHaveBeenCalledOnce();
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it("fails closed with a message when the runJobCli export is missing", async () => {
    // Vitest's mock proxy throws on undefined keys, so model "missing" explicitly.
    mockTickEntry(() => ({ runJobCli: undefined }));
    await runCli(BACKGROUND_TICK_INTERNAL_FLAG);
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("background tick failed"));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("runJobCli export missing"));
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it("reports a tick failure without falling back to the UI", async () => {
    mocks.runJobCli.mockRejectedValue(new Error("boom"));
    mockTickEntry(() => ({ runJobCli: mocks.runJobCli }));
    await runCli(BACKGROUND_TICK_INTERNAL_FLAG);
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("background tick failed: boom"));
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it("only matches the flag in the reexec position, so it is not a user command", async () => {
    await runCli("hello", BACKGROUND_TICK_INTERNAL_FLAG);
    expect(mocks.main).toHaveBeenCalledOnce();
    expect(mocks.runJobCli).not.toHaveBeenCalled();
  });
});
