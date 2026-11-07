import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ home: "", platform: "darwin" as NodeJS.Platform }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fake.home, platform: () => fake.platform };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(), execFile: vi.fn(), execFileSync: vi.fn(() => { throw new Error("not found"); }) };
});

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  encodeWindowsSandboxPolicy,
  isWindowsDriveRoot,
  isWindowsSandboxHelperAvailable,
  listWindowsSandboxGrants,
  quoteWindowsArgument,
  recordWindowsSandboxGrants,
  windowsArgvInvocation,
  windowsSandboxEnv,
  windowsShellInvocation,
  WINDOWS_SANDBOX_HELPER_ENV,
  WINDOWS_SANDBOX_NETWORK_DENY_MESSAGE,
} from "../utils/windows-sandbox.js";

const root = mkdtempSync(join(tmpdir(), "agav-windows-sandbox-test-"));
fake.home = join(root, "home");
mkdirSync(fake.home, { recursive: true });
const helper = join(root, "agav-sandbox.exe");
writeFileSync(helper, "fake helper");
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

function decodePolicy(text: string): Array<[string, string]> {
  return text.trim().split("\n").map((line) => {
    const [key, hex] = line.split(" ");
    return [key!, Buffer.from(hex!, "hex").toString("utf8")];
  });
}

let capturedPolicies: string[] = [];
function successfulChild(_file: string, args: string[]): any {
  // The policy file is removed after the process closes; capture it at spawn time.
  if (args[0] === "exec") capturedPolicies.push(readFileSync(args[1]!, "utf8"));
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("close", 0, null));
  return child;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Windows argument quoting", () => {
  it.each([
    ["plain", "plain"],
    ["with space", '"with space"'],
    ["", '""'],
    ['say "hi"', '"say \\"hi\\""'],
    ["C:\\dir\\", "C:\\dir\\"],
    ["C:\\my dir\\", '"C:\\my dir\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
  ])("quotes %j as %j", (input, expected) => {
    expect(quoteWindowsArgument(input)).toBe(expected);
  });

  it("rejects NUL characters", () => {
    expect(() => quoteWindowsArgument("a\0b")).toThrow(/NUL/);
    expect(() => windowsShellInvocation("echo\0x")).toThrow(/NUL/);
  });

  it("builds argv and cmd.exe invocations", () => {
    expect(windowsArgvInvocation(["npx", "vitest", "run", "src dir"])).toEqual({ app: "", cmdline: 'npx vitest run "src dir"' });
    expect(windowsShellInvocation('echo "a&b"', "C:\\Windows")).toEqual({
      app: "C:\\Windows\\System32\\cmd.exe",
      cmdline: 'cmd.exe /d /s /c "echo "a&b""',
    });
  });
});

describe("Windows sandbox policy encoding", () => {
  const policy = {
    cwd: "C:\\proj é", app: "", cmdline: 'cmd.exe /d /s /c "echo hi"',
    grants: ["C:\\proj é", "C:\\Temp\\agav-sandbox"], denyFiles: ["C:\\proj é\\.zshrc"],
    denyDirs: ["C:\\proj é\\.agav"], denyDeletes: ["C:\\proj é\\.git"],
  };

  it("round-trips every value through hex-encoded UTF-8 lines", () => {
    expect(decodePolicy(encodeWindowsSandboxPolicy(policy))).toEqual([
      ["cwd", "C:\\proj é"], ["app", ""], ["cmdline", 'cmd.exe /d /s /c "echo hi"'],
      ["grant", "C:\\proj é"], ["grant", "C:\\Temp\\agav-sandbox"],
      ["deny-delete", "C:\\proj é\\.git"], ["deny-file", "C:\\proj é\\.zshrc"], ["deny-dir", "C:\\proj é\\.agav"],
    ]);
  });

  it("requires a writable root and rejects NUL", () => {
    expect(() => encodeWindowsSandboxPolicy({ ...policy, grants: [] })).toThrow(/writable root/);
    expect(() => encodeWindowsSandboxPolicy({ ...policy, denyFiles: ["a\0b"] })).toThrow(/NUL/);
  });

  it("recognizes drive roots", () => {
    expect(isWindowsDriveRoot("C:\\")).toBe(true);
    expect(isWindowsDriveRoot("D:")).toBe(true);
    expect(isWindowsDriveRoot("C:\\proj")).toBe(false);
  });

  it("redirects temp and caches case-insensitively", () => {
    const env = windowsSandboxEnv({ Temp: "C:\\Users\\me\\Temp", tmp: "x", NPM_CONFIG_CACHE: "y", PATH: "C:\\bin" }, "C:\\T\\agav-sandbox");
    expect(env).toEqual({
      PATH: "C:\\bin",
      TEMP: "C:\\T\\agav-sandbox",
      TMP: "C:\\T\\agav-sandbox",
      npm_config_cache: join("C:\\T\\agav-sandbox", "npm-cache"),
      PIP_CACHE_DIR: join("C:\\T\\agav-sandbox", "pip-cache"),
      YARN_CACHE_FOLDER: join("C:\\T\\agav-sandbox", "yarn-cache"),
    });
  });
});

describe("Windows sandbox grant journal", () => {
  it("records each root once, case-insensitively", () => {
    recordWindowsSandboxGrants(["C:\\Proj", "C:\\Temp\\agav-sandbox"]);
    recordWindowsSandboxGrants(["c:\\proj", "C:\\Other"]);
    expect(listWindowsSandboxGrants()).toEqual(["C:\\Proj", "C:\\Temp\\agav-sandbox", "C:\\Other"]);
    expect(JSON.parse(readFileSync(join(fake.home, ".agav", "sandbox", "windows-grants.json"), "utf8"))).toHaveLength(3);
  });
});

describe("Windows sandbox backend selection and execution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(successfulChild as any);
    capturedPolicies = [];
    fake.platform = "win32";
    vi.stubEnv("AGAV_NO_SANDBOX", "");
    vi.stubEnv(WINDOWS_SANDBOX_HELPER_ENV, helper);
  });
  afterEach(() => { vi.unstubAllEnvs(); fake.platform = "darwin"; });

  it("is opt-in: Windows defaults to none until windowsSandbox is enabled", async () => {
    const sandbox = await import("../utils/sandbox.js");
    expect(sandbox.detectSandboxBackend()).toBe("none");
    sandbox.setWindowsSandboxEnabled(true);
    expect(sandbox.detectSandboxBackend()).toBe("windows");
    expect(sandbox.getSandboxName()).toBe("Windows restricted token");
    vi.stubEnv("AGAV_NO_SANDBOX", "1");
    expect(sandbox.detectSandboxBackend()).toBe("none");
  });

  it("falls back to none when enabled but no helper exists", async () => {
    vi.stubEnv(WINDOWS_SANDBOX_HELPER_ENV, join(root, "missing.exe"));
    const sandbox = await import("../utils/sandbox.js");
    sandbox.setWindowsSandboxEnabled(true);
    expect(isWindowsSandboxHelperAvailable()).toBe(false);
    expect(sandbox.detectSandboxBackend()).toBe("none");
    expect(sandbox.getAvailableSandboxOverrides()).not.toContain("windows");
  });

  it("offers windows as an override when a helper exists", async () => {
    const sandbox = await import("../utils/sandbox.js");
    expect(sandbox.getAvailableSandboxOverrides()).toContain("windows");
  });

  it("refuses sandboxNetwork=deny without launching anything", async () => {
    const sandbox = await import("../utils/sandbox.js");
    sandbox.setSandboxNetwork("deny");
    const result = await sandbox.runInSandbox({ command: "echo hi", cwd: workspace, timeout: 1000, maxBuffer: 1024, forceBackend: "windows" });
    expect(result.backend).toBe("windows");
    expect(result.error?.message).toBe(WINDOWS_SANDBOX_NETWORK_DENY_MESSAGE);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses the windows override on other platforms without launching anything", async () => {
    fake.platform = "linux";
    const sandbox = await import("../utils/sandbox.js");
    const result = await sandbox.runInSandbox({ command: "echo hi", cwd: workspace, timeout: 1000, maxBuffer: 1024, forceBackend: "windows" });
    expect(result.error?.message).toMatch(/only available on Windows/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses when the helper is unavailable instead of running unsandboxed", async () => {
    vi.stubEnv(WINDOWS_SANDBOX_HELPER_ENV, join(root, "missing.exe"));
    const sandbox = await import("../utils/sandbox.js");
    const result = await sandbox.runInSandbox({ command: "echo hi", cwd: workspace, timeout: 1000, maxBuffer: 1024, forceBackend: "windows" });
    expect(result.error?.message).toMatch(/helper is not available/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs commands through the helper with a cmd.exe policy and redirected TEMP", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("AGAV_TEST_API_TOKEN", "secret");
    const sandbox = await import("../utils/sandbox.js");
    const result = await sandbox.runInSandbox({ command: "echo hi", cwd: workspace, timeout: 1000, maxBuffer: 1024, forceBackend: "windows", onOutput: () => {} });
    expect(result.error).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toBe(helper);
    expect(args[0]).toBe("exec");
    expect((options as any).env.TEMP).toMatch(/agav-sandbox$/);
    expect((options as any).env).not.toHaveProperty("AGAV_TEST_API_TOKEN");
    const policy = decodePolicy(capturedPolicies[0]!);
    expect(policy).toContainEqual(["app", "C:\\Windows\\System32\\cmd.exe"]);
    expect(policy).toContainEqual(["cmdline", 'cmd.exe /d /s /c "echo hi"']);
    const grants = policy.filter(([key]) => key === "grant").map(([, value]) => value);
    expect(grants[0]).toMatch(/workspace$/);
    expect(grants[1]).toMatch(/agav-sandbox$/);
    // Grants are journaled before the helper runs, so they can always be revoked.
    expect(listWindowsSandboxGrants()).toEqual(expect.arrayContaining(grants));
  });

  it("only protects paths inside the workspace", async () => {
    mkdirSync(join(workspace, ".agav"), { recursive: true });
    writeFileSync(join(workspace, ".zshrc"), "");
    const sandbox = await import("../utils/sandbox.js");
    await sandbox.runInSandbox({ command: "echo hi", cwd: workspace, timeout: 1000, maxBuffer: 1024, forceBackend: "windows" });
    const policy = decodePolicy(capturedPolicies[0]!);
    const protectedPaths = policy.filter(([key]) => key.startsWith("deny-")).map(([, value]) => value);
    expect(protectedPaths.length).toBeGreaterThan(0);
    const resolvedWorkspace = policy.find(([key]) => key === "cwd")![1];
    for (const path of protectedPaths) expect(path.startsWith(resolvedWorkspace)).toBe(true);
    expect(policy).toContainEqual(["deny-dir", join(resolvedWorkspace, ".agav")]);
    expect(policy).toContainEqual(["deny-file", join(resolvedWorkspace, ".zshrc")]);
  });

  it("wraps run_tests argv directly (no shell) when windows is the default backend", async () => {
    const sandbox = await import("../utils/sandbox.js");
    sandbox.setWindowsSandboxEnabled(true);
    const built = sandbox.buildSandboxedCommand({ cmd: "npx", args: ["vitest", "run", "a b"], cwd: workspace });
    try {
      expect(built.backend).toBe("windows");
      expect(built.file).toBe(helper);
      const policy = decodePolicy(readFileSync(built.args[1]!, "utf8"));
      expect(policy).toContainEqual(["app", ""]);
      expect(policy).toContainEqual(["cmdline", 'npx vitest run "a b"']);
    } finally { built.cleanup(); }
  });

  it("refuses run_tests under sandboxNetwork=deny rather than running unsandboxed", async () => {
    const sandbox = await import("../utils/sandbox.js");
    sandbox.setWindowsSandboxEnabled(true);
    sandbox.setSandboxNetwork("deny");
    expect(() => sandbox.buildSandboxedCommand({ cmd: "npx", args: ["vitest"], cwd: workspace })).toThrow(WINDOWS_SANDBOX_NETWORK_DENY_MESSAGE);
  });
});
