import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../utils/sandbox-workspace.js", () => ({
  prepareSandboxWorkspace: vi.fn((cwd: string) => ({ path: cwd + "/snapshot", publish: vi.fn(), cleanup: vi.fn() })),
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

function successfulChild(): any {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("close", 0, null));
  return child;
}
vi.mock("node:os", () => ({
  platform: vi.fn(),
  tmpdir: vi.fn(() => "/tmp"),
}));
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  createWriteStream: vi.fn(),
  readFileSync: vi.fn(),
  lstatSync: vi.fn(() => { throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); }),
  readlinkSync: vi.fn(),
  realpathSync: vi.fn((path: string) => path),
}));
vi.mock("node:path", async original => ({
  ...await original<typeof import("node:path")>(),
  join: vi.fn((...parts: string[]) => parts.join("/")),
}));

import { execFileSync, spawn } from "node:child_process";
import { isDestructiveCommand, requireSandbox } from "../utils/sandbox.js";

const execFileSyncMock = vi.mocked(execFileSync);

describe("utils/sandbox", () => {
  let exitListeners: Function[];
  beforeEach(() => {
    exitListeners = process.listeners("exit");
    delete process.env.AGAV_NO_SANDBOX;
    vi.clearAllMocks();
    vi.mocked(spawn).mockImplementation(successfulChild);
  });

  afterEach(() => {
    // resetModules creates fresh runner cleanup listeners; don't retain them across tests.
    for (const listener of process.listeners("exit")) {
      if (!exitListeners.includes(listener)) process.removeListener("exit", listener as () => void);
    }
    delete process.env.AGAV_NO_SANDBOX;
  });

  it("detects seatbelt when sandbox-exec is available", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");
    vi.mocked(cp.execFileSync).mockImplementation((...args: any[]) => {
      if (args[0] === "/bin/sh" && args[1]?.[1]?.includes("sandbox-exec")) {
        return Buffer.from("/usr/bin/sandbox-exec\n");
      }
      throw new Error("not found");
    });

    expect(sandbox.detectSandboxBackend()).toBe("seatbelt");
    expect(sandbox.getSandboxName()).toBe("macOS Seatbelt");
  });

  it("detects bubblewrap when bwrap is available", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");
    vi.mocked(cp.execFileSync).mockImplementation((...args: any[]) => {
      if (args[0] === "/bin/sh" && args[1]?.[1]?.includes("bwrap")) {
        return Buffer.from("/usr/bin/bwrap\n");
      }
      throw new Error("not found");
    });

    expect(sandbox.detectSandboxBackend()).toBe("bubblewrap");
    expect(sandbox.getSandboxName()).toBe("Linux Bubblewrap");
  });

  it("returns none when AGAV_NO_SANDBOX is set", async () => {
    vi.resetModules();
    process.env.AGAV_NO_SANDBOX = "1";
    const sandbox = await import("../utils/sandbox.js");
    expect(sandbox.detectSandboxBackend()).toBe("none");
    expect(sandbox.getSandboxName()).toBe("none (unsandboxed)");
    delete process.env.AGAV_NO_SANDBOX;
  });

  it.each(["none", "invalid", "", null, 123])("rejects unauthorized or invalid override %s before execution", async (forceBackend) => {
    vi.resetModules();
    const sandbox = await import("../utils/sandbox.js");
    execFileSyncMock.mockReturnValue(Buffer.from("/usr/bin/sandbox-exec\n"));
    await expect(sandbox.runInSandbox({
      command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024,
      forceBackend: forceBackend as any,
    })).rejects.toThrow(/sandbox/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("allows explicit user opt-out but still rejects unknown backends", async () => {
    vi.resetModules();
    const sandbox = await import("../utils/sandbox.js");
    process.env.AGAV_NO_SANDBOX = "1";
    expect((await sandbox.runInSandbox({ command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024, forceBackend: "none" })).backend).toBe("none");
    await expect(sandbox.runInSandbox({ command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024, forceBackend: "typo" as any })).rejects.toThrow(/sandbox/i);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retains automatic unsandboxed execution on unsupported systems", async () => {
    vi.resetModules();
    const sandbox = await import("../utils/sandbox.js");
    execFileSyncMock.mockImplementation(() => { throw new Error("not found"); });
    expect((await sandbox.runInSandbox({ command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024 })).backend).toBe("none");
  });

  it("preserves explicit direct user shell execution and environment inheritance", async () => {
    vi.resetModules();
    const sandbox = await import("../utils/sandbox.js");
    const result = await sandbox.runInSandbox({ command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024, forceBackend: "none", allowUnsandboxed: true, inheritEnv: true } as any);
    expect(result.backend).toBe("none");
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toBeUndefined();
  });

  it.each([false, true])("preserves quoted Windows shell syntax (streaming: %s)", async (streaming) => {
    vi.resetModules();
    const os = await import("node:os");
    vi.mocked(os.platform).mockReturnValue("win32");
    const sandbox = await import("../utils/sandbox.js");
    const commands = [
      '"C:\\Program Files\\nodejs\\npx.cmd" hyperframes --version',
      '"C:\\Program Files\\tools\\inspect.cmd" "argument with spaces" "" "C:\\output dir\\"',
      '"C:\\Program Files\\tools\\inspect.cmd" "a&b" && echo done',
      '"C:\\Program Files\\tools\\inspect.cmd" | findstr output > "result file.txt"',
    ];
    try {
      for (const command of commands) {
        const result = await sandbox.runInSandbox({
          command, cwd: "C:\\project dir", timeout: 1000, maxBuffer: 1024,
          ...(streaming ? { onOutput: () => {} } : {}),
        });
        expect(result.error).toBeNull();
        expect(spawn).toHaveBeenLastCalledWith("cmd.exe", ["/d", "/s", "/c", `"${command}"`], expect.objectContaining({
          cwd: "C:\\project dir", detached: false, windowsVerbatimArguments: true,
        }));
      }
    } finally {
      vi.mocked(os.platform).mockReset();
    }
  });

  it.each([false, true])("does not apply cmd quoting to Windows Docker execution (streaming: %s)", async (streaming) => {
    vi.resetModules();
    const os = await import("node:os");
    vi.mocked(os.platform).mockReturnValue("win32");
    const cp = await import("node:child_process");
    vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
      args.at(-1)(null, "", "");
      return {} as any;
    });
    const sandbox = await import("../utils/sandbox.js");
    const command = 'printf "%s" "argument with spaces"';
    try {
      await sandbox.runInSandbox({ command, cwd: "C:\\project dir", timeout: 1000, maxBuffer: 1024,
        forceBackend: "docker", ...(streaming ? { onOutput: () => {} } : {}),
      });
      const calls = streaming ? vi.mocked(cp.spawn).mock.calls : vi.mocked(cp.execFile).mock.calls;
      const call = calls.find(([file, args]) => file === "docker" && args?.includes("run"));
      expect(call).toBeDefined();
      expect(call![1]).toContain(command);
      expect(call![2]).not.toHaveProperty("windowsVerbatimArguments", true);
    } finally {
      vi.mocked(os.platform).mockReset();
    }
  });

  it("flags destructive commands", () => {
    expect(isDestructiveCommand("rm -rf /")).toBe(true);
    expect(isDestructiveCommand("git push --force origin main")).toBe(true);
    expect(isDestructiveCommand("echo hello")).toBe(false);
  });

  it("does not flag similar but non-destructive commands", () => {
    expect(isDestructiveCommand("rm -r folder")).toBe(false);
    expect(isDestructiveCommand("git push origin main")).toBe(false);
    expect(isDestructiveCommand("chmod -R 755 .")).toBe(false);
    expect(isDestructiveCommand("curl https://example.com | python")).toBe(false);
  });

  it("requireSandbox throws when backend is none", async () => {
    vi.resetModules();
    process.env.AGAV_NO_SANDBOX = "1";
    const sandbox = await import("../utils/sandbox.js");
    expect(() => sandbox.requireSandbox()).toThrow("Sandbox required but no sandbox backend is available");
    delete process.env.AGAV_NO_SANDBOX;
  });

  it("requireSandbox does not throw when backend is seatbelt", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");
    vi.mocked(cp.execFileSync).mockImplementation((...args: any[]) => {
      if (args[0] === "/bin/sh" && args[1]?.[1]?.includes("sandbox-exec")) {
        return Buffer.from("/usr/bin/sandbox-exec\n");
      }
      throw new Error("not found");
    });

    expect(() => sandbox.requireSandbox()).not.toThrow();
  });

  it("forwards cancellation to the buffered Docker CLI", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");
    vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
      args.at(-1)(null, "", "");
      return {} as any;
    });
    const controller = new AbortController();
    await sandbox.runInSandbox({ command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024, forceBackend: "docker", signal: controller.signal });
    expect(cp.execFile).toHaveBeenCalledWith("docker", expect.arrayContaining(["run"]), expect.objectContaining({ signal: controller.signal }), expect.any(Function));
  });

  it("runInSandbox maps current user uid/gid for docker containers", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const os = await import("node:os");
    const sandbox = await import("../utils/sandbox.js");
    
    // Mock os.userInfo to return specific uid/gid
    (os as any).userInfo = vi.fn(() => ({ uid: 501, gid: 20 }));
    
    // Mock execFile to instantly resolve
    vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      callback(null, "success", "");
      return {} as any;
    });

    await sandbox.runInSandbox({
      command: "echo test",
      cwd: "/test/dir",
      timeout: 1000,
      maxBuffer: 1024,
      forceBackend: "docker"
    });

    // Extract the execFile calls
    const calls = vi.mocked(cp.execFile).mock.calls;
    
    // Verify the main execution container
    const runCall = calls.find(call => 
      call[0] === "docker" && 
      call[1]?.includes("node:22-slim") &&
      call[1]?.includes("echo test")
    );

    expect(runCall).toBeDefined();
    expect(runCall![1]).toContain("-e");
    expect(runCall![1]).toContain("HOME=/workspace");
    expect(runCall![1]).toContain("-u");
    expect(runCall![1]).toContain("501:20");
  });

  it("runInSandbox omits UID mapping if actual rootless Docker is detected", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const os = await import("node:os");
    const sandbox = await import("../utils/sandbox.js");
    
    (os as any).userInfo = vi.fn(() => ({ uid: 501, gid: 20 }));
    
    vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
      const commandArgs = args[1] as string[];
      const callback = args[args.length - 1];
      
      // Simulate actual rootless docker response for 'docker info'
      if (commandArgs && commandArgs.includes("info")) {
        callback(null, "SecurityOptions:\n name=rootless\n", "");
      } else {
        callback(null, "success", "");
      }
      return {} as any;
    });

    await sandbox.runInSandbox({
      command: "echo test",
      cwd: "/test/dir",
      timeout: 1000,
      maxBuffer: 1024,
      forceBackend: "docker"
    });

    const calls = vi.mocked(cp.execFile).mock.calls;
    const runCall = calls.find(call => 
      call[0] === "docker" && 
      call[1]?.includes("node:22-slim") &&
      call[1]?.includes("echo test")
    );

    expect(runCall).toBeDefined();
    expect(runCall![1]).toContain("HOME=/workspace");
    expect(runCall![1]).toContain("USER=agav");
    // MUST NOT contain -u mapping
    expect(runCall![1]).not.toContain("-u");
    expect(runCall![1]).not.toContain("501:20");
  });

  it("runInSandbox preserves UID mapping and disables userns isolation if daemon-level userns-remap is detected instead of rootless", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const os = await import("node:os");
    const sandbox = await import("../utils/sandbox.js");
    
    (os as any).userInfo = vi.fn(() => ({ uid: 501, gid: 20 }));
    
    vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
      const commandArgs = args[1] as string[];
      const callback = args[args.length - 1];
      
      // Simulate standard daemon userns-remap (not rootless)
      if (commandArgs && commandArgs.includes("info")) {
        callback(null, "SecurityOptions:\n name=userns\n", "");
      } else {
        callback(null, "success", "");
      }
      return {} as any;
    });

    await sandbox.runInSandbox({
      command: "echo test",
      cwd: "/test/dir",
      timeout: 1000,
      maxBuffer: 1024,
      forceBackend: "docker"
    });

    const calls = vi.mocked(cp.execFile).mock.calls;
    const runCall = calls.find(call => 
      call[0] === "docker" && 
      call[1]?.includes("node:22-slim") &&
      call[1]?.includes("echo test")
    );

    expect(runCall).toBeDefined();
    // MUST bypass the daemon's user namespace remapping
    expect(runCall![1]).toContain("--userns=host");
    // MUST contain -u mapping because userns is not rootless
    expect(runCall![1]).toContain("-u");
    expect(runCall![1]).toContain("501:20");
  });

  it("preserves operational environment variables while filtering credentials", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");
    const keys = ["PATH", "NODE_ENV", "VIRTUAL_ENV", "BASE_URL", "GITHUB_TOKEN", "GITHUB_PAT", "DATABASE_URL"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));

    try {
      process.env.PATH = "/usr/local/bin:/usr/bin";
      process.env.NODE_ENV = "production";
      process.env.VIRTUAL_ENV = "/tmp/venv";
      process.env.BASE_URL = "https://example.test";
      process.env.GITHUB_TOKEN = "secret-token";
      process.env.GITHUB_PAT = "secret-pat";
      process.env.DATABASE_URL = "postgres://user:password@example.test/app";
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
        const callback = args[args.length - 1];
        callback(null, "success", "");
        return {} as any;
      });

      await sandbox.runInSandbox({
        command: "echo test",
        cwd: "/test/dir",
        timeout: 1000,
        maxBuffer: 1024,
        forceBackend: "none", allowUnsandboxed: true,
      });

      const call = vi.mocked(cp.spawn).mock.calls.find((args) => args[0] === "/bin/sh");
      const env = call?.[2]?.env as Record<string, string>;
      expect(env).toMatchObject({
        PATH: "/usr/local/bin:/usr/bin",
        NODE_ENV: "production",
        VIRTUAL_ENV: "/tmp/venv",
        BASE_URL: "https://example.test",
      });
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      expect(env).not.toHaveProperty("GITHUB_PAT");
      expect(env).not.toHaveProperty("DATABASE_URL");
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.each(["seatbelt", "bubblewrap", "docker"] as const)("ignores skill environment inheritance for %s", async (backend) => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");
    vi.stubEnv("AGAV_TEST_API_TOKEN", "harmless-credential");
    vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
      args.at(-1)(null, "success", "");
      return {} as any;
    });
    try {
      await sandbox.runInSandbox({
        command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024,
        forceBackend: backend, inheritEnv: true,
      });
      if (backend === "docker") {
        const args = vi.mocked(cp.execFile).mock.calls.find(call => call[1]?.includes("run"))?.[1];
        expect(args).toBeDefined();
        expect(args?.join(" ")).not.toContain("AGAV_TEST_API_TOKEN");
        expect(args?.join(" ")).not.toContain("harmless-credential");
      } else {
        const env = vi.mocked(cp.spawn).mock.calls[0]?.[2]?.env;
        expect(env).toBeDefined();
        expect(env).not.toHaveProperty("AGAV_TEST_API_TOKEN");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["seatbelt", "bubblewrap"] as const)("fails closed when %s cannot launch despite skill inheritance", async (backend) => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");
    vi.stubEnv("AGAV_TEST_API_TOKEN", "harmless-credential");
    vi.mocked(cp.spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.emit("error", new Error("ENOENT"));
        child.emit("close", -1, null);
      });
      return child;
    });
    try {
      const result = await sandbox.runInSandbox({
        command: "echo test", cwd: "/tmp", timeout: 1000, maxBuffer: 1024,
        forceBackend: backend, inheritEnv: true,
      });
      expect(result.backend).toBe(backend);
      expect(result.error?.message).toContain("ENOENT");
      expect(cp.spawn).toHaveBeenCalledTimes(1);
      expect(sandbox.detectSandboxBackend()).not.toBe("none");
      const env = vi.mocked(cp.spawn).mock.calls.at(-1)?.[2]?.env;
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("AGAV_TEST_API_TOKEN");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed on protected-path discovery errors before writing a profile or launching", async () => {
    vi.resetModules();
    const fs = await import("node:fs");
    const sandbox = await import("../utils/sandbox.js");
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    await expect(sandbox.runInSandbox({ command: "echo unsafe", cwd: "/workspace", timeout: 1000, maxBuffer: 1024, forceBackend: "seatbelt" }))
      .rejects.toThrow("permission denied");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("seatbelt allows cache/config dirs but keeps credential dirs denied", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const fs = await import("node:fs");
    const sandbox = await import("../utils/sandbox.js");

    const prevHome = process.env.HOME;
    process.env.HOME = "/Users/tester";
    try {
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
        const callback = args[args.length - 1];
        callback(null, "success", "");
        return {} as any;
      });

      await sandbox.runInSandbox({
        command: "echo test",
        cwd: "/Users/tester/project",
        timeout: 1000,
        maxBuffer: 1024,
        forceBackend: "seatbelt",
      });

      // The profile written to disk must restore writes to cache/config dirs
      // while still blocking the credential directories.
      const profile = vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string;
      expect(profile).toContain('(allow file-write* (subpath (param "HOME_CACHE")))');
      expect(profile).toContain('(allow file-write* (subpath (param "HOME_CONFIG")))');
      expect(profile).toContain('(allow file-write* (subpath (param "HOME_NPM")))');
      expect(profile).toContain('(deny file-write* (subpath (param "HOME_SSH")))');
      expect(profile).toContain('(deny file-read* (subpath (param "HOME_SSH")))');
      // Writes are denied by default; the blanket deny must appear before the
      // carve-out allows so last-match-wins can re-enable the cache dirs.
      expect(profile).toContain("(deny file-write*)");
      expect(profile.indexOf("(deny file-write*)"))
        .toBeLessThan(profile.indexOf('(allow file-write* (subpath (param "HOME_CACHE")))'));
      // HOME can itself be inside TMPDIR. Temporary write grants must not
      // reopen unrelated home paths; workspace/cache exceptions follow HOME.
      const homeDeny = profile.indexOf('(deny file-write* (subpath (param "HOME")))');
      expect(homeDeny).toBeGreaterThan(profile.indexOf('(allow file-write* (subpath (param "TMPDIR")))'));
      expect(homeDeny).toBeGreaterThan(profile.indexOf('(allow file-write* (subpath "/private/tmp"))'));
      expect(homeDeny).toBeLessThan(profile.indexOf('(allow file-write* (subpath (param "CWD")))'));
      expect(homeDeny).toBeLessThan(profile.indexOf('(allow file-write* (subpath (param "HOME_CACHE")))'));
      // Credential denies come AFTER the workspace/cache allows so they win.
      expect(profile.indexOf('(allow file-write* (subpath (param "CWD")))'))
        .toBeLessThan(profile.indexOf('(deny file-write* (subpath (param "HOME_SSH")))'));

      const runArgs = vi.mocked(cp.spawn).mock.calls.find(
        (call) => call[0] === "sandbox-exec",
      )?.[1] as string[];
      expect(runArgs).toContain("HOME_CACHE=/Users/tester/.cache");
      expect(runArgs).toContain("HOME_CONFIG=/Users/tester/.config");
      expect(runArgs).toContain("HOME_NPM=/Users/tester/.npm");
      expect(runArgs).toContain("HOME_SSH=/Users/tester/.ssh");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("bubblewrap mounts writable tmpfs over cache/config dirs and empty tmpfs over credential dirs", async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    const sandbox = await import("../utils/sandbox.js");

    const prevHome = process.env.HOME;
    process.env.HOME = "/home/tester";
    try {
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => {
        const callback = args[args.length - 1];
        callback(null, "success", "");
        return {} as any;
      });

      await sandbox.runInSandbox({
        command: "echo test",
        cwd: "/home/tester/project",
        timeout: 1000,
        maxBuffer: 1024,
        forceBackend: "bubblewrap",
      });

      const args = vi.mocked(cp.spawn).mock.calls.find(
        (call) => call[0] === "bwrap",
      )?.[1] as string[];
      const joined = args.join(" ");
      // Writable scratch for tooling caches.
      expect(joined).toContain("--tmpfs /home/tester/.cache");
      expect(joined).toContain("--tmpfs /home/tester/.config");
      expect(joined).toContain("--tmpfs /home/tester/.npm");
      expect(joined).toContain("--tmpfs /home/tester/.cargo");
      // Installed Python/uv runtimes and user executables remain visible via
      // the root read-only bind; Cargo shims are restored over its scratch home.
      expect(joined).not.toContain("--tmpfs /home/tester/.local");
      expect(joined).not.toContain("--tmpfs /home/tester/.rustup");
      expect(joined).toContain("--ro-bind-try /home/tester/.cargo/bin /home/tester/.cargo/bin");
      expect(args.indexOf("--ro-bind-try")).toBeGreaterThan(args.indexOf("/home/tester/.cargo"));
      expect(joined).not.toContain("--bind /home/tester /home/tester");
      // Credential dirs are still masked with tmpfs.
      expect(joined).toContain("--tmpfs /home/tester/.ssh");
      expect(joined).toContain("--tmpfs /home/tester/.gnupg");
      // Host /tmp is not bind-mounted (no socket leakage).
      expect(joined).not.toContain("--bind /tmp /tmp");
      expect(joined).toContain("--tmpfs /tmp");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
  it.each([
    "/tmp/project",
    "/home/tester/.cache/project",
    "/home/tester/.config/project",
    "/home/tester/.cargo/project",
    "/home/tester/.cargo/bin/project",
    "/home/tester/.ssh/project",
  ])("bubblewrap restores workspace %s after scratch mounts but before credential masks", async (cwd) => {
    vi.resetModules();
    vi.stubEnv("HOME", "/home/tester");
    try {
      const sandbox = await import("../utils/sandbox.js");
      await sandbox.runInSandbox({ command: "echo test", cwd, timeout: 1000, maxBuffer: 1024, forceBackend: "bubblewrap" });
      const args = vi.mocked(spawn).mock.calls.find(call => call[0] === "bwrap")![1] as string[];
      const workspace = args.indexOf("--bind");
      expect(args.slice(workspace, workspace + 3)).toEqual(["--bind", cwd + "/snapshot", cwd]);
      for (const scratch of ["/tmp", "/home/tester/.cache", "/home/tester/.config", "/home/tester/.npm", "/home/tester/.cargo"]) {
        expect(args.indexOf(scratch)).toBeLessThan(workspace);
      }
      expect(args.indexOf("--ro-bind-try")).toBeLessThan(workspace);
      for (const credential of [".ssh", ".aws", ".gnupg"]) {
        expect(args.indexOf(`/home/tester/${credential}`)).toBeGreaterThan(workspace);
      }
      expect(args.indexOf("--chdir")).toBeGreaterThan(workspace);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["/home/tester", "/home", "/", "/home/tester/", "/home/tester/project/..", "/home/tester/.cargo", "/home/tester/.config"])("keeps scratch masks effective when workspace %s contains them", async (cwd) => {
    vi.resetModules();
    vi.stubEnv("HOME", "/home/tester");
    try {
      const { isWithinRoot } = await import("../utils/path-guard.js");
      const sandbox = await import("../utils/sandbox.js");
      await sandbox.runInSandbox({ command: "echo test", cwd, timeout: 1000, maxBuffer: 1024, forceBackend: "bubblewrap" });
      const args = vi.mocked(spawn).mock.calls.find(call => call[0] === "bwrap")![1] as string[];
      const workspace = args.indexOf("--bind");
      for (const dir of [".cache", ".config", ".npm", ".cargo"]) {
        const path = `/home/tester/${dir}`;
        if (isWithinRoot(cwd, path)) {
          const mask = args.findIndex((arg, index) => arg === "--tmpfs" && args[index + 1] === path);
          expect(mask).toBeGreaterThan(workspace + 2);
        }
      }
      const cargoMask = args.findIndex((arg, index) => arg === "--tmpfs" && args[index + 1] === "/home/tester/.cargo");
      expect(args.indexOf("--ro-bind-try")).toBeGreaterThan(cargoMask);
      expect(args.lastIndexOf("/home/tester/.ssh")).toBeGreaterThan(workspace + 2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("network isolation (Stage A)", () => {
    it("defaults to allow and round-trips the policy", async () => {
      vi.resetModules();
      const sandbox = await import("../utils/sandbox.js");
      expect(sandbox.getSandboxNetwork()).toBe("allow");
      sandbox.setSandboxNetwork("allow");
      expect(sandbox.getSandboxNetwork()).toBe("allow");
      sandbox.setSandboxNetwork("deny");
      expect(sandbox.getSandboxNetwork()).toBe("deny");
      // Unknown values fail closed rather than granting host networking.
      sandbox.setSandboxNetwork("allow");
      sandbox.setSandboxNetwork("bogus" as any);
      expect(sandbox.getSandboxNetwork()).toBe("deny");
    });

    it("shares host networking on seatbelt and bubblewrap when no policy is set", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      const fs = await import("node:fs");
      const sandbox = await import("../utils/sandbox.js");
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => { args.at(-1)(null, "ok", ""); return {} as any; });

      await sandbox.runInSandbox({ command: "echo test", cwd: "/tmp/project", timeout: 1000, maxBuffer: 1024, forceBackend: "seatbelt" });
      const profile = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
      expect(profile).not.toContain("(deny network*)");
      // Filesystem protections are unaffected by the network default.
      expect(profile).toContain("(deny file-write*)");
      expect(profile).toContain('(deny file-read* (subpath (param "HOME_SSH")))');

      await sandbox.runInSandbox({ command: "echo test", cwd: "/home/tester/project", timeout: 1000, maxBuffer: 1024, forceBackend: "bubblewrap" });
      const args = vi.mocked(spawn).mock.calls.find(call => call[0] === "bwrap")![1] as string[];
      expect(args).not.toContain("--unshare-net");
      expect(args).toContain("--unshare-pid");
    });

    it("seatbelt profile denies network with loopback carve-out when deny", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      const fs = await import("node:fs");
      const sandbox = await import("../utils/sandbox.js");
      sandbox.setSandboxNetwork("deny");
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => { args.at(-1)(null, "ok", ""); return {} as any; });

      await sandbox.runInSandbox({ command: "echo test", cwd: "/tmp/project", timeout: 1000, maxBuffer: 1024, forceBackend: "seatbelt" });

      const profile = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
      expect(profile).toContain("(deny network*)");
      expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
      expect(profile).toContain('(allow network-inbound network-bind (local ip "localhost:*"))');
      // A local-address exception must never grant outbound access. Incoming
      // connections and binds use the local endpoint; connects use the remote.
      expect(profile).not.toContain('(allow network* (local ip');
      expect(profile).not.toContain('(allow network* (remote ip');
      expect(profile.indexOf("(deny network*)"))
        .toBeLessThan(profile.indexOf('(allow network-outbound (remote ip "localhost:*"))'));
    });

    it("seatbelt profile omits network rules when allow", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      const fs = await import("node:fs");
      const sandbox = await import("../utils/sandbox.js");
      sandbox.setSandboxNetwork("allow");
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => { args.at(-1)(null, "ok", ""); return {} as any; });

      await sandbox.runInSandbox({ command: "echo test", cwd: "/tmp/project", timeout: 1000, maxBuffer: 1024, forceBackend: "seatbelt" });

      const profile = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
      expect(profile).not.toContain("(deny network*)");
    });

    it("bubblewrap unshares the network namespace when deny, shares it when allow", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      const sandbox = await import("../utils/sandbox.js");
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => { args.at(-1)(null, "ok", ""); return {} as any; });

      sandbox.setSandboxNetwork("deny");
      await sandbox.runInSandbox({ command: "echo test", cwd: "/home/tester/project", timeout: 1000, maxBuffer: 1024, forceBackend: "bubblewrap" });
      const denyArgs = vi.mocked(spawn).mock.calls.find(call => call[0] === "bwrap")![1] as string[];
      expect(denyArgs).toContain("--unshare-net");

      vi.mocked(spawn).mockClear();
      sandbox.setSandboxNetwork("allow");
      await sandbox.runInSandbox({ command: "echo test", cwd: "/home/tester/project", timeout: 1000, maxBuffer: 1024, forceBackend: "bubblewrap" });
      const allowArgs = vi.mocked(spawn).mock.calls.find(call => call[0] === "bwrap")![1] as string[];
      expect(allowArgs).not.toContain("--unshare-net");
    });

    it("buildSandboxedCommand (run_tests path) applies the network policy", async () => {
      vi.resetModules();
      const cp = await import("node:child_process");
      cp; // backend detection: execFileSync throws => backend "none" in this suite
      const sandbox = await import("../utils/sandbox.js");
      vi.mocked(execFileSyncMock).mockImplementation((...args: any[]) => {
        if (args[0] === "/bin/sh" && args[1]?.[1]?.includes("bwrap")) return Buffer.from("/usr/bin/bwrap\n");
        throw new Error("not found");
      });
      const implicit = sandbox.buildSandboxedCommand({ cmd: "npx", args: ["vitest", "run"], cwd: "/home/tester/project" });
      expect(implicit.backend).toBe("bubblewrap");
      expect(implicit.args).not.toContain("--unshare-net");
      implicit.cleanup();
      sandbox.setSandboxNetwork("deny");
      const built = sandbox.buildSandboxedCommand({ cmd: "npx", args: ["vitest", "run"], cwd: "/home/tester/project" });
      expect(built.backend).toBe("bubblewrap");
      expect(built.args).toContain("--unshare-net");
      built.cleanup();
    });
  });

  describe("workspace config protection (bubblewrap)", () => {
    it("binds only a private snapshot, hides its staging path and isolates descendants", async () => {
      const sandbox = await import("../utils/sandbox.js");
      await sandbox.runInSandbox({ command: "echo test", cwd: "/home/tester/project", timeout: 1000, maxBuffer: 1024, forceBackend: "bubblewrap" });
      const args = vi.mocked(spawn).mock.calls.find(call => call[0] === "bwrap")![1] as string[];
      expect(args).toContain("--unshare-pid");
      const bind = args.indexOf("--bind");
      expect(args.slice(bind, bind + 3)).toEqual(["--bind", "/home/tester/project/snapshot", "/home/tester/project"]);
      expect(args).not.toContain("/home/tester/project/.git/hooks");
    });

    it("carves workspace config out of the seatbelt deny-write base", async () => {
      // Under (deny file-write*), a later (deny subpath) wins over the workspace
      // allow, so the protected paths are emitted as deny rules + PROTECTED_N
      // params resolving under the (realpath-resolved) workspace.
      vi.resetModules();
      const cp = await import("node:child_process");
      const fs = await import("node:fs");
      const sandbox = await import("../utils/sandbox.js");
      vi.mocked(cp.execFile).mockImplementation((...args: any[]) => { args.at(-1)(null, "ok", ""); return {} as any; });
      await sandbox.runInSandbox({ command: "echo test", cwd: "/Users/tester/project", timeout: 1000, maxBuffer: 1024, forceBackend: "seatbelt" });
      const profile = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1] as string;
      const runArgs = vi.mocked(cp.spawn).mock.calls.find(call => call[0] === "sandbox-exec")?.[1] as string[];

      // Deny-write base + /dev carve-out (git/tools open /dev/null read-write).
      expect(profile).toContain("(deny file-write*)");
      expect(profile).toContain('(allow file-write* (subpath "/dev"))');
      // .git/hooks (dir) uses subpath; .zshrc (file) uses literal.
      expect(profile).toContain('(deny file-write* (subpath (param "PROTECTED_0")))');
      expect(profile).toMatch(/\(deny file-write\* \(literal \(param "PROTECTED_\d+"\)\)\)/);
      // Both hooks and configuration are protected; ordinary Git state is writable.
      expect(runArgs.some((a) => typeof a === "string" && a.endsWith("/.git/hooks"))).toBe(true);
      expect(runArgs.some((a) => typeof a === "string" && a.startsWith("PROTECTED_") && a.endsWith("/.git/config"))).toBe(true);
      expect(runArgs.some((a) => typeof a === "string" && a.startsWith("PROTECTED_") && a.endsWith("/.git/config.worktree"))).toBe(true);
      expect(profile).toMatch(/\(deny file-write-unlink \(literal \(param "PROTECTED_\d+"\)\)\)/);
      // The protection denies come AFTER the workspace allow (so they win).
      expect(profile.indexOf('(allow file-write* (subpath (param "CWD")))'))
        .toBeLessThan(profile.indexOf('(deny file-write* (subpath (param "PROTECTED_0")))'));
    });
  });
});
