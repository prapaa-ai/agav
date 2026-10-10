import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/sandbox.js", async original => ({
  ...await original<typeof import("../utils/sandbox.js")>(),
  runInSandbox: vi.fn(),
  detectSandboxBackend: vi.fn(() => "none"),
  getAvailableSandboxOverrides: vi.fn(() => []),
}));
import { runInSandbox } from "../utils/sandbox.js";
import { createShellTool, shellTool } from "../tools/shell.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runInSandbox).mockResolvedValue({ stdout: "", stderr: "", error: null, backend: "none" });
});
afterEach(() => vi.restoreAllMocks());

describe("shell timeout override", () => {
  it("retains the 30-second default", async () => {
    expect((await shellTool.execute({ command: "echo harmless" })).isError).toBe(false);
    expect(runInSandbox).toHaveBeenCalledWith(expect.objectContaining({ timeout: 30_000 }));
  });

  it.each([1, 1000, 30_000, 60_000, 120_000])("passes a valid %i ms override without changing execution options", async timeout => {
    const controller = new AbortController();
    await shellTool.execute({ command: "echo harmless", timeout_ms: timeout, sandbox: "docker" }, { signal: controller.signal });
    expect(runInSandbox).toHaveBeenCalledOnce();
    expect(runInSandbox).toHaveBeenCalledWith(expect.objectContaining({ command: "echo harmless", timeout,
      forceBackend: "docker", signal: controller.signal, maxBuffer: 80_000, onOutput: expect.any(Function) }));
  });

  it.each([0, -1, 1.5, 120_001, Number.MAX_SAFE_INTEGER, NaN, Infinity, "60000", "", null, true, {}])("rejects invalid timeout %s before execution", async timeout => {
    const result = await shellTool.execute({ command: "echo harmless", timeout_ms: timeout });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/timeout_ms.*integer.*1.*120000/);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it("retains streamed partial output and timeout failure", async () => {
    vi.mocked(runInSandbox).mockImplementationOnce(async options => {
      options.onOutput?.(Buffer.from("partial"), "stdout");
      return { stdout: "", stderr: "", backend: "none", error: new Error("Command timed out after 60000ms") };
    });
    const result = await shellTool.execute({ command: "build", timeout_ms: 60_000 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("partial");
    expect(result.output).toContain("timed out after 60000ms");
    expect(runInSandbox).toHaveBeenCalledOnce();
  });

  it("does not bypass destructive-command blocking", async () => {
    expect((await shellTool.execute({ command: "rm -rf /", timeout_ms: 120_000 })).isError).toBe(true);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it.each([shellTool, createShellTool()])("advertises identical optional bounded timeout metadata", tool => {
    const properties = tool.schema.inputSchema.properties as Record<string, unknown>;
    expect(properties.timeout_ms).toMatchObject({ type: "integer", minimum: 1, maximum: 120_000, default: 30_000 });
    expect(tool.schema.inputSchema.required).toEqual(["command"]);
    expect(tool.schema.description).toContain("Defaults to a 30 second timeout");
  });
});
