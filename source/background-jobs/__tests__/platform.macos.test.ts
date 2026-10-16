/**
 * T03 — macOS PlatformAdapter unit tests.
 *
 * IMPORTANT: this test suite runs on Linux (this repo's dev/CI sandbox), NOT
 * on macOS. `platform/macos.ts` is pure POSIX logic (spawn/kill/realpath/
 * O_EXCL file locking) with no macOS-only syscalls invoked by these code
 * paths, so exercising it on Linux is a reasonable POSIX-compatible proxy
 * for the adapter's *logic* (process-group spawn/signal/verify, realpath
 * canonicalization, exclusive-lock mutual exclusion). It is explicitly NOT
 * proof of macOS compatibility: it does not exercise macOS-specific
 * behavior such as `sandbox-exec` policy acceptance, APFS case-insensitive
 * path semantics, launchd process re-adoption, or any macOS-version-specific
 * quirk of `ps`/`kill`. See the T03 handoff report for the explicit list of
 * what was and was not verified.
 *
 * Structured after source/background-jobs/__tests__/platform.linux.test.ts
 * and source/__tests__/shell-process.test.ts's real-subprocess test style
 * (no mocking of child_process/fs — real temp files and real child
 * processes are used).
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platformAdapter } from "../platform/macos.js";

// Gate on POSIX platforms generally (not darwin-only) since this suite is a
// Linux-run proxy for POSIX logic shared with the real macOS target, per the
// file-level comment above. Skips cleanly on win32.
describe.skipIf(process.platform === "win32")("platform/macos adapter (POSIX-compatible proxy run on Linux, NOT macOS)", () => {
  it("detectCapabilities resolves without throwing and reports platform/scope/limitations", async () => {
    const caps = await platformAdapter.detectCapabilities();
    expect(caps.platform).toBe("darwin");
    expect(caps.strongestOwnershipScope).toBe("process-group");
    expect(caps.nativeHelperAvailable).toBe(true);
    expect(caps.supportsGracefulApplicationShutdown).toBe(true);
    // No cgroup equivalent exists on macOS at all; must be unconditionally false.
    expect(caps.supportsDelegatedCgroup).toBe(false);
    expect(Array.isArray(caps.availableIsolationBackends)).toBe(true);
    // availableIsolationBackends may only ever contain "seatbelt" for this adapter.
    for (const backend of caps.availableIsolationBackends) {
      expect(backend).toBe("seatbelt");
    }
    expect(Array.isArray(caps.limitations)).toBe(true);
    // The no-cgroup-equivalent limitation must always be disclosed.
    expect(caps.limitations.some((l) => /cgroup/i.test(l))).toBe(true);
    // If seatbelt was detected as available, the deprecation/version-variance
    // caveat must also be disclosed — never a bare "available" claim.
    if (caps.availableIsolationBackends.includes("seatbelt")) {
      expect(caps.limitations.some((l) => /deprecat/i.test(l))).toBe(true);
    }
  });

  it("verifyAlive returns false for a pid that does not exist", async () => {
    const alive = await platformAdapter.verifyAlive({ pid: 999_999, creationIdentity: "bogus" });
    expect(alive).toBe(false);
  });

  it("launchDetachedSupervisor + verifyAlive + stopOwnedScope round-trip against a real long-lived process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-macos-adapter-test-"));
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
      // ownershipHandle equals the pid (which equals the pgid for a detached
      // group leader), per the adapter's documented contract.
      expect(launch.ownershipHandle).toBe(String(launch.identity.pid));

      const aliveNow = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveNow).toBe(true);

      // A pid that exists but with a mismatched creationIdentity must not be
      // reported alive (guards against PID-reuse false positives).
      const mismatched = await platformAdapter.verifyAlive({
        pid: launch.identity.pid,
        creationIdentity: "definitely-not-the-real-starttime",
      });
      expect(mismatched).toBe(false);

      const stopOutcome = await platformAdapter.stopOwnedScope(launch.ownershipHandle, launch.ownershipScope, 2000);
      expect(stopOutcome.observedStopped).toBe(true);
      expect(stopOutcome.verifiedNoDescendants).toBe(true);
      expect(stopOutcome.limitations.length).toBeGreaterThan(0);
      expect(stopOutcome.limitations.some((l) => /cgroup/i.test(l))).toBe(true);

      const aliveAfterStop = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveAfterStop).toBe(false);
    } finally {
      try {
        await platformAdapter.forceStopOwnedScope(String(launch.identity.pid), "process-group");
      } catch {
        // ignore
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forceStopOwnedScope kills a process group that ignores SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-macos-adapter-force-test-"));
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
    const dir = await mkdtemp(join(tmpdir(), "agav-macos-adapter-path-test-"));
    try {
      const resolved = await platformAdapter.canonicalizePath(dir);
      expect(resolved.length).toBeGreaterThan(0);
      await expect(platformAdapter.canonicalizePath(join(dir, "does-not-exist"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("acquireLock prevents a second concurrent acquisition until released", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-macos-adapter-lock-test-"));
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
