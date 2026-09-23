import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock("node:os", () => ({
  platform: vi.fn(),
  tmpdir: vi.fn(() => "/tmp"),
}));
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  createWriteStream: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock("node:path", () => ({
  join: vi.fn((...parts: string[]) => parts.join("/")),
}));

import { execFileSync } from "node:child_process";
import { isDestructiveCommand, requireSandbox } from "../utils/sandbox.js";

const execFileSyncMock = vi.mocked(execFileSync);

describe("utils/sandbox", () => {
  beforeEach(() => {
    delete process.env.AGAV_NO_SANDBOX;
    vi.clearAllMocks();
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
        forceBackend: "none",
      });

      const call = vi.mocked(cp.execFile).mock.calls.find((args) => args[0] === "/bin/sh");
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
      // The blanket home deny must appear before the carve-out allows so
      // last-match-wins can re-enable the cache dirs.
      expect(profile.indexOf('(deny file-write* (subpath (param "HOME")))'))
        .toBeLessThan(profile.indexOf('(allow file-write* (subpath (param "HOME_CACHE")))'));

      const runArgs = vi.mocked(cp.execFile).mock.calls.find(
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

      const args = vi.mocked(cp.execFile).mock.calls.find(
        (call) => call[0] === "bwrap",
      )?.[1] as string[];
      const joined = args.join(" ");
      // Writable scratch for tooling caches.
      expect(joined).toContain("--tmpfs /home/tester/.cache");
      expect(joined).toContain("--tmpfs /home/tester/.config");
      expect(joined).toContain("--tmpfs /home/tester/.npm");
      expect(joined).toContain("--tmpfs /home/tester/.cargo");
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
});
