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
});