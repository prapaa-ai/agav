import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

type BufferedOutcome = { exitCode: number | null; timedOut: boolean };
const executeBufferedCommand = vi.fn<(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; cwd?: string; env?: Record<string, string>; windowsVerbatimArguments?: boolean },
  callback: (error: Error | null, stdout: string, stderr: string, outcome: BufferedOutcome) => void,
  signal?: AbortSignal,
) => void>();

const workspace = vi.hoisted(() => ({ path: "/tmp/isolated/workspace", publish: vi.fn(), cleanup: vi.fn() }));
vi.mock("../utils/sandbox-workspace.js", () => ({ prepareSandboxWorkspace: () => workspace }));
vi.mock("node:child_process", () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(), writeFileSync: vi.fn(), unlinkSync: vi.fn(),
}));
vi.mock("node:os", async original => ({
  ...await original<typeof import("node:os")>(), platform: () => "linux",
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.mocked(execFile).mockImplementation(() => { throw new Error("Unexpected direct execFile call"); });
  // Recreate the partial mock so each test gets a fresh backend detection cache.
  vi.doMock("../utils/sandbox.js", async original => ({
    ...await original<typeof import("../utils/sandbox.js")>(),
    executeBufferedCommand,
  }));
  vi.stubEnv("AGAV_NO_SANDBOX", "0");
});
afterEach(() => {
  vi.doUnmock("../utils/sandbox.js");
  vi.unstubAllEnvs();
});

async function runner(backend: "seatbelt" | "bubblewrap" | "none") {
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    if (args?.[1] === `command -v ${backend === "seatbelt" ? "sandbox-exec" : "bwrap"}` && backend !== "none") return Buffer.from("installed");
    throw new Error("not installed");
  });
  return (await import("../tools/test-runner.js")).testRunnerTool;
}
function output(stdout: string, stderr = "", error: Error | null = null, outcome: BufferedOutcome = { exitCode: 0, timedOut: false }) {
  executeBufferedCommand.mockImplementation((_file, _args, _options, callback) => {
    callback(error, stdout, stderr, outcome);
  });
}
function missing(backend: string, cmd: string) {
  return backend === "seatbelt"
    ? `sandbox-exec: execvp() of '${cmd}' failed: No such file or directory\n`
    : `bwrap: execvp ${cmd}: No such file or directory\n`;
}

describe.each(["seatbelt", "bubblewrap"] as const)("run_tests under %s", backend => {
  it("wraps argv, filters credentials, forwards cancellation, and cleans up", async () => {
    const tool = await runner(backend);
    vi.stubEnv("AGAV_TEST_TOKEN", "not-for-tests");
    output(" Tests  2 passed (2)");
    const controller = new AbortController();
    const result = await tool.execute({ framework: "vitest", path: "test/space ; literal.test.ts" }, { signal: controller.signal });
    expect(result.verification).toMatchObject({ status: "passed", passed: 2 });
    const [file, args, options, , signal] = executeBufferedCommand.mock.calls[0]!;
    expect(file).toBe(backend === "seatbelt" ? "sandbox-exec" : "bwrap");
    expect(args.slice(-5)).toEqual(["npx", "vitest", "run", "--reporter=verbose", "test/space ; literal.test.ts"]);
    expect(options).toMatchObject({ cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    expect(options.env).not.toHaveProperty("AGAV_TEST_TOKEN");
    expect(signal).toBe(controller.signal);
    if (backend === "seatbelt") {
      const [profile] = vi.mocked(writeFileSync).mock.calls[0]!;
      expect(args.slice(0, 2)).toEqual(["-f", profile]);
      expect(unlinkSync).toHaveBeenCalledWith(profile);
    } else {
      expect(workspace.cleanup).toHaveBeenCalledOnce();
    }
  });

  it.each([["pytest", "python"], ["vitest", "npx"], ["go", "go"], ["cargo", "cargo"]])("classifies missing %s executables inside the wrapper", async (framework, cmd) => {
    const tool = await runner(backend);
    const exitCode = backend === "seatbelt" ? 71 : 1;
    output("", missing(backend, cmd), new Error("wrapper exited"), { exitCode, timedOut: false });
    const result = await tool.execute({ framework });
    expect(result.isError).toBe(true);
    expect(result.verification).toMatchObject({ status: "failed", failureKind: "runner_unavailable", passed: 0, failed: 0 });
    expect(result.output).toContain("Do not modify source code");
  });

  it.each([
    [" Test Files  1 passed (1)\n Tests  2 passed (2)", "exact"],
    [" Tests  1 failed (1)", "exact"],
    ["", "different command"],
    ["", "extra diagnostic"],
    ["", "other backend"],
  ])("does not misclassify workload output (%s, %s)", async (stdout, kind) => {
    const tool = await runner(backend);
    const stderr = kind === "different command" ? missing(backend, "other")
      : kind === "extra diagnostic" ? `test setup failed\n${missing(backend, "npx")}`
      : kind === "other backend" ? missing(backend === "seatbelt" ? "bubblewrap" : "seatbelt", "npx")
      : missing(backend, "npx");
    output(stdout, stderr, new Error("failed"), { exitCode: 1, timedOut: false });
    const result = await tool.execute({ framework: "vitest" });
    expect(result.isError).toBe(true);
    expect(result.verification).not.toHaveProperty("failureKind");
  });

  it("does not classify cancellation as a missing runner", async () => {
    const tool = await runner(backend);
    const controller = new AbortController();
    executeBufferedCommand.mockImplementation((_file, _args, _options, callback) => {
      controller.abort();
      callback(new Error("cancelled"), "", missing(backend, "go"), { exitCode: null, timedOut: false });
    });
    const result = await tool.execute({ framework: "go" }, { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(result.verification).not.toHaveProperty("failureKind");
    expect(result.output).toContain("cancelled");
    expect(result.output).not.toContain("timed out");
  });

  it("fails closed when the wrapper cannot launch, without retrying unsandboxed", async () => {
    const tool = await runner(backend);
    output("", "", Object.assign(new Error("missing wrapper"), { code: "ENOENT" }), { exitCode: null, timedOut: false });
    const result = await tool.execute({ framework: "go" });
    expect(result.isError).toBe(true);
    expect(result.verification).toMatchObject({ failureKind: "runner_unavailable" });
    expect(executeBufferedCommand).toHaveBeenCalledOnce();
    expect(execFile).not.toHaveBeenCalled();
    if (backend === "seatbelt") expect(unlinkSync).toHaveBeenCalledOnce();
  });

  it("cleans up after synchronous launcher failure", async () => {
    const tool = await runner(backend);
    executeBufferedCommand.mockImplementation(() => { throw new Error("startup error"); });
    const result = await tool.execute({ framework: "go" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("startup error");
    if (backend === "seatbelt") expect(unlinkSync).toHaveBeenCalledOnce();
    else expect(workspace.cleanup).toHaveBeenCalledOnce();
  });
});

it("refuses execution when sandboxRequired has no backend", async () => {
  const tool = await runner("none");
  const sandbox = await import("../utils/sandbox.js");
  sandbox.setSandboxRequired(true);
  const result = await tool.execute({ framework: "go" });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("Sandbox required");
  expect(executeBufferedCommand).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
});

it("reports publication rejection and cleans up without crediting passing tests", async () => {
  const tool = await runner("bubblewrap");
  output(" Tests  2 passed (2)");
  workspace.publish.mockImplementationOnce(() => { throw new Error("protected path changed"); });
  const result = await tool.execute({ framework: "vitest" });
  expect(result.isError).toBe(true);
  expect(result.verification?.status).toBe("failed");
  expect(result.output).toContain("protected path changed");
  expect(workspace.cleanup).toHaveBeenCalledOnce();
});
it("publishes only successful test invocations", async () => {
  const tool = await runner("bubblewrap");
  output(" Tests  1 failed (1)", "", new Error("tests failed"), { exitCode: 1, timedOut: false });
  await tool.execute({ framework: "vitest" });
  expect(workspace.publish).not.toHaveBeenCalled();
  expect(workspace.cleanup).toHaveBeenCalledOnce();
  output(" Tests  2 passed (2)");
  await tool.execute({ framework: "vitest" });
  expect(workspace.publish).toHaveBeenCalledOnce();
});

it("does not publish after cancellation even if the child reports success", async () => {
  const tool = await runner("bubblewrap");
  const controller = new AbortController();
  executeBufferedCommand.mockImplementation((_file, _args, _options, callback) => {
    controller.abort();
    callback(null, " Tests  2 passed (2)", "", { exitCode: 0, timedOut: false });
  });
  await tool.execute({ framework: "vitest" }, { signal: controller.signal });
  expect(executeBufferedCommand).toHaveBeenCalledOnce();
  expect(workspace.publish).not.toHaveBeenCalled();
  expect(workspace.cleanup).toHaveBeenCalledOnce();
});

it("reports cleanup errors after a synchronous launcher failure", async () => {
  const tool = await runner("bubblewrap");
  executeBufferedCommand.mockImplementation(() => { throw new Error("launcher failed"); });
  workspace.cleanup.mockImplementationOnce(() => { throw new Error("cleanup failed"); });
  const result = await tool.execute({ framework: "vitest" });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("launcher failed");
  expect(result.output).toContain("cleanup failed");
});

describe("run_tests timeout", () => {
  it("forwards the default timeout", async () => {
    const tool = await runner("seatbelt");
    output(" Tests  2 passed (2)");
    const result = await tool.execute({ framework: "vitest" });
    expect(result.verification?.status).toBe("passed");
    expect(executeBufferedCommand.mock.calls[0]?.[2]).toMatchObject({ timeout: 120_000 });
  });

  it("forwards a custom timeout and preserves parsed counts on timeout", async () => {
    const tool = await runner("seatbelt");
    output(" Test Files  1 failed (1)\n Tests  1 failed | 2 passed (3)", "", new Error("terminated"), { exitCode: null, timedOut: true });
    const result = await tool.execute({ framework: "vitest", timeout_ms: 35 });
    expect(executeBufferedCommand.mock.calls[0]?.[2]).toMatchObject({ timeout: 35 });
    expect(result.isError).toBe(true);
    expect(result.verification).toMatchObject({ status: "failed", passed: 2, failed: 1 });
    expect(result.output).toContain("timed out after 35 ms");
    expect(unlinkSync).toHaveBeenCalledOnce();
  });

  it("does not publish on timeout even if the process leader exited successfully", async () => {
    const tool = await runner("bubblewrap");
    output(" Tests  2 passed (2)", "", null, { exitCode: 0, timedOut: true });
    const result = await tool.execute({ framework: "vitest", timeout_ms: 35 });
    expect(result.isError).toBe(true);
    expect(result.verification).toMatchObject({ status: "failed", passed: 2, failed: 0 });
    expect(result.output).toContain("timed out after 35 ms");
    expect(workspace.publish).not.toHaveBeenCalled();
    expect(workspace.cleanup).toHaveBeenCalledOnce();
  });

  it.each([null, 0, 1.5, "25", 600001])("rejects invalid timeout %j before launch", async (timeout_ms) => {
    const tool = await runner("seatbelt");
    expect(await tool.execute({ framework: "vitest", timeout_ms })).toMatchObject({ isError: true, output: expect.stringContaining("Invalid timeout_ms") });
    expect(executeBufferedCommand).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});
