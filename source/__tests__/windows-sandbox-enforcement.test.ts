/**
 * Real enforcement checks for the Windows restricted-token sandbox. Runs only
 * on Windows with AGAV_WINDOWS_SANDBOX_HELPER pointing at a built helper (the
 * sandbox-enforcement workflow builds it). The workflow asserts this suite
 * executed with no skips, so a silently disabled sandbox cannot pass.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInSandbox, setSandboxNetwork } from "../utils/sandbox.js";
import { listWindowsSandboxGrants, revokeWindowsSandboxGrants } from "../utils/windows-sandbox.js";

const SANDBOX_SID = "S-1-9-3816436473-1446516585-2387212101-1016720224";
const enabled = process.platform === "win32" && !!process.env.AGAV_WINDOWS_SANDBOX_HELPER;

describe.skipIf(!enabled)("Windows restricted-token sandbox", () => {
  let root = "";
  let workspace = "";
  let outside = "";

  const run = (command: string, timeout = 60_000) =>
    runInSandbox({ command, cwd: workspace, timeout, maxBuffer: 1024 * 1024, forceBackend: "windows" });

  beforeAll(() => {
    // The user profile temp directory grants only the user, SYSTEM and
    // Administrators, so it does not mask results with an Everyone grant.
    root = mkdtempSync(join(tmpdir(), "agav-winsandbox-"));
    workspace = join(root, "workspace");
    outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "agav@example.com");
    git("config", "user.name", "agav");
    writeFileSync(join(workspace, "tracked.txt"), "hello\n");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "init");
    mkdirSync(join(workspace, ".agav"));
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(join(workspace, ".zshrc"), "");
  });

  afterEach(() => setSandboxNetwork("allow"));

  afterAll(() => {
    try { revokeWindowsSandboxGrants(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  it("allows writes inside the workspace", async () => {
    const result = await run("echo ok> made.txt");
    expect(result.error).toBeNull();
    expect(existsSync(join(workspace, "made.txt"))).toBe(true);
  });

  it("denies writes outside the workspace", async () => {
    const target = join(outside, "escape.txt");
    const result = await run(`echo x> "${target}"`);
    expect(result.error).not.toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  it("denies writes to protected Git hooks and Agav/editor configuration", async () => {
    for (const relative of [".git\\hooks\\pre-commit", ".agav\\config.json", ".vscode\\tasks.json"]) {
      const result = await run(`echo evil> ${relative}`);
      expect(result.error, relative).not.toBeNull();
      expect(existsSync(join(workspace, relative)), relative).toBe(false);
    }
    const result = await run("echo evil> .zshrc");
    expect(result.error).not.toBeNull();
  });

  it("keeps ordinary Git usable", async () => {
    const result = await run("echo more>> tracked.txt && git add tracked.txt && git -c user.email=agav@example.com -c user.name=agav commit -q -m change && git status --porcelain");
    expect(result.error).toBeNull();
  });

  it("provides a writable TEMP directory", async () => {
    const result = await run('echo x> "%TEMP%\\agav-temp-probe.txt"');
    expect(result.error).toBeNull();
  });

  it("terminates descendants when the command times out", async () => {
    const started = Date.now();
    const result = await run(`"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, 2_000);
    expect(result.error?.message).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("refuses sandboxNetwork=deny instead of running unconfined", async () => {
    setSandboxNetwork("deny");
    const result = await run("echo ok> network-probe.txt");
    expect(result.error?.message).toMatch(/cannot enforce sandboxNetwork=deny/);
    expect(existsSync(join(workspace, "network-probe.txt"))).toBe(false);
  });

  it("journals and revokes its permission entries", () => {
    // Grants are journaled as resolved real paths (runners may report 8.3 temp names).
    const resolved = realpathSync(workspace).toLowerCase();
    const grants = listWindowsSandboxGrants();
    expect(grants.some((path) => path.toLowerCase() === resolved)).toBe(true);
    expect(execFileSync("icacls", [workspace], { encoding: "utf8" })).toContain(SANDBOX_SID);
    const { failed } = revokeWindowsSandboxGrants();
    expect(failed).toEqual([]);
    expect(execFileSync("icacls", [workspace], { encoding: "utf8" })).not.toContain(SANDBOX_SID);
  });
});
