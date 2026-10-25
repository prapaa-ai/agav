import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WP-04 (0.7): sandboxRequired is enforced per run_command call against the
// effective backend (forceBackend ?? detectSandboxBackend()).
vi.mock("../utils/sandbox.js", async original => ({
  ...await original<typeof import("../utils/sandbox.js")>(),
  runInSandbox: vi.fn(),
  detectSandboxBackend: vi.fn(() => "none"),
  getAvailableSandboxOverrides: vi.fn(() => []),
}));
import { detectSandboxBackend, runInSandbox, setSandboxRequired, isSandboxRequired } from "../utils/sandbox.js";
import { shellTool } from "../tools/shell.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runInSandbox).mockResolvedValue({ stdout: "ok", stderr: "", error: null, backend: "bubblewrap" });
});
afterEach(() => {
  setSandboxRequired(false);
  delete process.env.AGAV_NO_SANDBOX;
});

describe("run_command with sandboxRequired", () => {
  it("defaults to not required", () => {
    expect(isSandboxRequired()).toBe(false);
  });

  it("refuses without executing when the detected backend is none", async () => {
    setSandboxRequired(true);
    vi.mocked(detectSandboxBackend).mockReturnValue("none");
    const result = await shellTool.execute({ command: "echo hi" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Sandbox required/);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it("runs when the detected backend is bubblewrap", async () => {
    setSandboxRequired(true);
    vi.mocked(detectSandboxBackend).mockReturnValue("bubblewrap");
    const result = await shellTool.execute({ command: "echo hi" });
    expect(result.isError).toBe(false);
    expect(runInSandbox).toHaveBeenCalledOnce();
  });

  it.each(["bubblewrap", "none"] as const)("refuses a forceBackend none override (detected %s), even with AGAV_NO_SANDBOX=1", async detected => {
    setSandboxRequired(true);
    process.env.AGAV_NO_SANDBOX = "1";
    vi.mocked(detectSandboxBackend).mockReturnValue(detected);
    const result = await shellTool.execute({ command: "echo hi", sandbox: "none" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Sandbox required/);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it("allows an installed sandboxed override when the detected backend is none", async () => {
    setSandboxRequired(true);
    vi.mocked(detectSandboxBackend).mockReturnValue("none");
    vi.mocked(runInSandbox).mockResolvedValueOnce({ stdout: "ok", stderr: "", error: null, backend: "docker" });
    const result = await shellTool.execute({ command: "echo hi", sandbox: "docker" });
    expect(result.isError).toBe(false);
    expect(runInSandbox).toHaveBeenCalledWith(expect.objectContaining({ forceBackend: "docker" }));
  });

  it("requireSandbox checks the effective backend when given one", async () => {
    const actual = await vi.importActual<typeof import("../utils/sandbox.js")>("../utils/sandbox.js");
    expect(() => actual.requireSandbox("docker")).not.toThrow();
    expect(() => actual.requireSandbox("bubblewrap")).not.toThrow();
    expect(() => actual.requireSandbox("none")).toThrow(/Sandbox required/);
  });

  it("leaves execution unchanged when not required", async () => {
    vi.mocked(detectSandboxBackend).mockReturnValue("none");
    vi.mocked(runInSandbox).mockResolvedValueOnce({ stdout: "ok", stderr: "", error: null, backend: "none" });
    const result = await shellTool.execute({ command: "echo hi" });
    expect(result.isError).toBe(false);
    expect(runInSandbox).toHaveBeenCalledOnce();
  });
});
