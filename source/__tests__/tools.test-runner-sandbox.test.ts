import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

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
  vi.stubEnv("AGAV_NO_SANDBOX", "0");
});
afterEach(() => vi.unstubAllEnvs());

async function runner(backend: "seatbelt" | "bubblewrap" | "none") {
  vi.mocked(execFileSync).mockImplementation((file, args) => {
    if (args?.[1] === `command -v ${backend === "seatbelt" ? "sandbox-exec" : "bwrap"}` && backend !== "none") return Buffer.from("installed");
    throw new Error("not installed");
  });
  return (await import("../tools/test-runner.js")).testRunnerTool;
}
function output(stdout: string, stderr = "", error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as Function)(error, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
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
    const [file, args, options] = vi.mocked(execFile).mock.calls[0]!;
    expect(file).toBe(backend === "seatbelt" ? "sandbox-exec" : "bwrap");
    expect(args?.slice(-5)).toEqual(["npx", "vitest", "run", "--reporter=verbose", "test/space ; literal.test.ts"]);
    expect(options).toMatchObject({ cwd: process.cwd(), signal: controller.signal });
    expect((options as { env: object }).env).not.toHaveProperty("AGAV_TEST_TOKEN");
    if (backend === "seatbelt") expect(unlinkSync).toHaveBeenCalledWith(vi.mocked(writeFileSync).mock.calls[0]![0]);
  });

  it.each([["pytest", "python"], ["vitest", "npx"], ["go", "go"], ["cargo", "cargo"]])("classifies missing %s executables inside the wrapper", async (framework, cmd) => {
    const tool = await runner(backend);
    output("", missing(backend, cmd), Object.assign(new Error("wrapper exited"), { code: backend === "seatbelt" ? 71 : 1 }));
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
    output(stdout, stderr, Object.assign(new Error("failed"), { code: 1 }));
    const result = await tool.execute({ framework: "vitest" });
    expect(result.isError).toBe(true);
    expect(result.verification).not.toHaveProperty("failureKind");
  });

  it("does not classify cancellation as a missing runner", async () => {
    const tool = await runner(backend);
    output("", missing(backend, "go"), Object.assign(new Error("cancelled"), { code: 1, signal: "SIGTERM", killed: true }));
    const result = await tool.execute({ framework: "go" });
    expect(result.verification).not.toHaveProperty("failureKind");
  });

  it("fails closed when the wrapper cannot launch, without retrying unsandboxed", async () => {
    const tool = await runner(backend);
    output("", "", Object.assign(new Error("missing wrapper"), { code: "ENOENT" }));
    const result = await tool.execute({ framework: "go" });
    expect(result.isError).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    if (backend === "seatbelt") expect(unlinkSync).toHaveBeenCalledOnce();
  });

  it("cleans up after synchronous execFile failure", async () => {
    const tool = await runner(backend);
    vi.mocked(execFile).mockImplementation(() => { throw new Error("startup error"); });
    const result = await tool.execute({ framework: "go" });
    expect(result.isError).toBe(true);
    if (backend === "seatbelt") expect(unlinkSync).toHaveBeenCalledOnce();
  });
});

it("refuses execution when sandboxRequired has no backend", async () => {
  const tool = await runner("none");
  const sandbox = await import("../utils/sandbox.js");
  sandbox.setSandboxRequired(true);
  const result = await tool.execute({ framework: "go" });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("Sandbox required");
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
  output(" Tests  1 failed (1)", "", Object.assign(new Error("tests failed"), { code: 1 }));
  await tool.execute({ framework: "vitest" });
  expect(workspace.publish).not.toHaveBeenCalled();
  expect(workspace.cleanup).toHaveBeenCalledOnce();
  output(" Tests  2 passed (2)");
  await tool.execute({ framework: "vitest" });
  expect(workspace.publish).toHaveBeenCalledOnce();
});

it("does not publish after cancellation even if the child reports success", async () => {
  const tool = await runner("bubblewrap");
  output(" Tests  2 passed (2)");
  const controller = new AbortController();
  controller.abort();
  await tool.execute({ framework: "vitest" }, { signal: controller.signal });
  expect(workspace.publish).not.toHaveBeenCalled();
  expect(workspace.cleanup).toHaveBeenCalledOnce();
});

it("reports cleanup errors after a synchronous launcher failure", async () => {
  const tool = await runner("bubblewrap");
  vi.mocked(execFile).mockImplementation(() => { throw new Error("launcher failed"); });
  workspace.cleanup.mockImplementationOnce(() => { throw new Error("cleanup failed"); });
  const result = await tool.execute({ framework: "vitest" });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("launcher failed");
  expect(result.output).toContain("cleanup failed");
});
