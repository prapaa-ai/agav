import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_RUNNER_INTERNAL_FLAG } from "../background-jobs/packaging/manifest.js";

const mocks = vi.hoisted(() => ({
  main: vi.fn(),
  importMain: vi.fn(),
  runSessionRunner: vi.fn(),
}));

const MAIN_ENTRY = "../main.js";
// Vite root-resolves the virtual entry when the runner is absent in this checkout.
const RUNNER_ENTRY = existsSync(new URL("../sessions/runner.ts", import.meta.url))
  ? "../sessions/runner.js"
  : "/source/sessions/runner.js";
const originalArgv = process.argv;
const originalExitCode = process.exitCode;

async function runCli(...args: string[]): Promise<void> {
  process.argv = [process.execPath, "agav", ...args];
  vi.resetModules();
  // Awaiting the import also awaits cli.tsx's top-level dispatch.
  await import("../cli.js");
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  // Track the import itself: not calling main is insufficient to prove Ink stays unloaded.
  vi.doMock(MAIN_ENTRY, () => {
    mocks.importMain();
    return { main: mocks.main, hasStartupFinished: () => true };
  });
  vi.doMock(RUNNER_ENTRY, () => ({ runSessionRunner: mocks.runSessionRunner }));
});

afterEach(() => {
  vi.doUnmock(MAIN_ENTRY);
  vi.doUnmock(RUNNER_ENTRY);
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("internal session runner flag", () => {
  it("routes the session id to the headless runner without importing main or Ink", async () => {
    mocks.runSessionRunner.mockResolvedValue(0);
    await runCli(SESSION_RUNNER_INTERNAL_FLAG, "session-123", "generation-123");
    expect(mocks.runSessionRunner).toHaveBeenCalledExactlyOnceWith("session-123", "generation-123");
    expect(mocks.importMain).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("propagates the runner's non-zero exit code", async () => {
    mocks.runSessionRunner.mockResolvedValue(7);
    await runCli(SESSION_RUNNER_INTERNAL_FLAG, "session-123");
    expect(mocks.runSessionRunner).toHaveBeenCalledExactlyOnceWith("session-123", undefined);
    expect(process.exitCode).toBe(7);
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(mocks.importMain).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it("reports runner errors with the session runner stage without falling back to main", async () => {
    mocks.runSessionRunner.mockRejectedValue(new Error("boom"));
    await runCli(SESSION_RUNNER_INTERNAL_FLAG, "session-123");
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith("\n  Agav — session runner failed: boom\n\n");
    expect(mocks.importMain).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it("reports startup import errors with the session runner stage without importing main", async () => {
    vi.doMock(RUNNER_ENTRY, () => {
      throw new Error("runner unavailable");
    });
    await runCli(SESSION_RUNNER_INTERNAL_FLAG, "session-123");
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("session runner failed:"));
    expect(mocks.runSessionRunner).not.toHaveBeenCalled();
    expect(mocks.importMain).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it("uses normal main when the flag is not in the reexec position", async () => {
    await runCli("hello", SESSION_RUNNER_INTERNAL_FLAG, "session-123");
    expect(mocks.importMain).toHaveBeenCalledOnce();
    expect(mocks.main).toHaveBeenCalledOnce();
    expect(mocks.runSessionRunner).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
