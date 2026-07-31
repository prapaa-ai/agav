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
import { isDestructiveCommand } from "../utils/sandbox.js";

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
});