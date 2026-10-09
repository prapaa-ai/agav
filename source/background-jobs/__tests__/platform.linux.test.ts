import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platformAdapter } from "../platform/linux.js";

// Real subprocesses, not mocks: this exercises actual detached spawn/signal
// behavior, matching the pattern in source/__tests__/shell-process.test.ts.
describe.skipIf(process.platform !== "linux")("platform/linux adapter", () => {
  it("detectCapabilities resolves without throwing and reports a platform/scope", async () => {
    const caps = await platformAdapter.detectCapabilities();
    expect(caps.platform).toBe("linux");
    expect(caps.strongestOwnershipScope).toBe("process-group");
    expect(caps.nativeHelperAvailable).toBe(true);
    expect(caps.supportsGracefulApplicationShutdown).toBe(true);
    expect(Array.isArray(caps.availableIsolationBackends)).toBe(true);
    expect(Array.isArray(caps.limitations)).toBe(true);
    // Delegated cgroup support must never be silently assumed true.
    expect(typeof caps.supportsDelegatedCgroup).toBe("boolean");
  });

  it("verifyAlive returns false for a pid that does not exist", async () => {
    // A pid that is astronomically unlikely to exist on a normal system.
    const alive = await platformAdapter.verifyAlive({ pid: 999_999, creationIdentity: "bogus" });
    expect(alive).toBe(false);
  });

  it("launchDetachedSupervisor + verifyAlive + stopOwnedScope round-trip against a real long-lived process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-linux-adapter-test-"));
    const scriptPath = join(dir, "fake-supervisor.mjs");
    // A trivial script that stays alive (no exit) until signalled.
    await writeFile(
      scriptPath,
      `
      process.on("SIGTERM", () => { /* ignore once so grace-window logic is exercised if ever needed */ });
      setInterval(() => {}, 1000);
      `,
      "utf8",
    );

    const launch = await platformAdapter.launchDetachedSupervisor({
      supervisorEntry: scriptPath,
      argv: [],
      env: { ...process.env, PATH: process.env.PATH ?? "" } as Record<string, string>,
      cwd: dir,
    });

    try {
      expect(launch.ownershipScope).toBe("process-group");
      expect(launch.identity.pid).toBeGreaterThan(0);
      expect(launch.ownershipHandle).toBe(String(launch.identity.pid));

      // Confirm it's actually alive and distinguishable via creation identity.
      const aliveNow = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveNow).toBe(true);

      // A pid that exists but with a mismatched creationIdentity must not
      // be reported alive (guards against PID-reuse false positives).
      const mismatched = await platformAdapter.verifyAlive({
        pid: launch.identity.pid,
        creationIdentity: "definitely-not-the-real-starttime",
      });
      expect(mismatched).toBe(false);

      const stopOutcome = await platformAdapter.stopOwnedScope(launch.ownershipHandle, launch.ownershipScope, 2000);
      expect(stopOutcome.observedStopped).toBe(true);
      expect(stopOutcome.verifiedNoDescendants).toBe(true);
      expect(stopOutcome.limitations.length).toBeGreaterThan(0);

      const aliveAfterStop = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveAfterStop).toBe(false);
    } finally {
      // Best-effort cleanup in case an assertion failed before stop.
      try {
        await platformAdapter.forceStopOwnedScope(String(launch.identity.pid), "process-group");
      } catch {
        // ignore
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forceStopOwnedScope kills a process group that ignores SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-linux-adapter-force-test-"));
    const scriptPath = join(dir, "stubborn-supervisor.mjs");
    await writeFile(
      scriptPath,
      `
      process.on("SIGTERM", () => {}); // swallow SIGTERM entirely
      setInterval(() => {}, 1000);
      `,
      "utf8",
    );

    const launch = await platformAdapter.launchDetachedSupervisor({
      supervisorEntry: scriptPath,
      argv: [],
      env: { ...process.env } as Record<string, string>,
      cwd: dir,
    });

    try {
      const outcome = await platformAdapter.forceStopOwnedScope(launch.ownershipHandle, launch.ownershipScope);
      expect(outcome.observedStopped).toBe(true);
      expect(outcome.verifiedNoDescendants).toBe(true);

      const aliveAfter = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveAfter).toBe(false);
    } finally {
      try {
        await platformAdapter.forceStopOwnedScope(String(launch.identity.pid), "process-group");
      } catch {
        // ignore
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("canonicalizePath resolves a real path and rejects a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-linux-adapter-path-test-"));
    try {
      const resolved = await platformAdapter.canonicalizePath(dir);
      expect(resolved.length).toBeGreaterThan(0);
      await expect(platformAdapter.canonicalizePath(join(dir, "does-not-exist"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("acquireLock prevents a second concurrent acquisition until released", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-linux-adapter-lock-test-"));
    const lockPath = join(dir, "job.lock");
    try {
      const release = await platformAdapter.acquireLock(lockPath);
      await expect(platformAdapter.acquireLock(lockPath)).rejects.toThrow();
      await release();
      const release2 = await platformAdapter.acquireLock(lockPath);
      await release2();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
