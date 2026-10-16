import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platformAdapter } from "../platform/windows.js";

/**
 * NOTE: this entire suite runs on Linux as a Node-API proxy for the Windows
 * adapter, NOT as proof of Windows compatibility. `spawn`, `process.kill`
 * with signal 0, `fs.realpath` and O_EXCL file creation all exist on Linux
 * too, so we can exercise the *Node-level* logic in windows.ts (argument
 * shapes, control flow, polling, error codes), but the OS-level guarantees
 * documented in windows.ts (TerminateProcess-only termination, no Job
 * Object tree ownership, no real creation-time disambiguator) are simply
 * asserted in comments/contract here — they cannot be verified without a
 * real Windows host. The one thing this suite CAN and DOES verify directly
 * is the fail-closed capability contract (nativeHelperAvailable: false,
 * strongestOwnershipScope: "unverified", non-empty limitations), which is
 * pure data/logic and fully portable.
 */
describe("platform/windows adapter (Node-API proxy on Linux, not a Windows conformance test)", () => {
  it("detectCapabilities truthfully reports the fail-closed contract", async () => {
    const caps = await platformAdapter.detectCapabilities();
    expect(caps.platform).toBe("win32");
    // The critical fail-closed assertions this adapter must satisfy per
    // solution.md §5/§7 and README.md's recorded T04 decision:
    expect(caps.nativeHelperAvailable).toBe(false);
    expect(caps.strongestOwnershipScope).toBe("unverified");
    expect(caps.supportsGracefulApplicationShutdown).toBe(false);
    expect(caps.supportsDelegatedCgroup).toBe(false);
    expect(caps.availableIsolationBackends).toEqual([]);
    expect(Array.isArray(caps.limitations)).toBe(true);
    expect(caps.limitations.length).toBeGreaterThan(0);
    // Limitations must actually explain *why*, not just exist.
    const joined = caps.limitations.join(" ");
    expect(joined).toMatch(/Job Object/i);
    expect(joined).toMatch(/native/i);
  });

  it("canonicalizePath resolves a real path and rejects a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-windows-adapter-path-test-"));
    try {
      const resolved = await platformAdapter.canonicalizePath(dir);
      expect(resolved.length).toBeGreaterThan(0);
      await expect(platformAdapter.canonicalizePath(join(dir, "does-not-exist"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("acquireLock prevents a second concurrent acquisition until released", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-windows-adapter-lock-test-"));
    const lockPath = join(dir, "job.lock");
    try {
      const release = await platformAdapter.acquireLock(lockPath);
      await expect(platformAdapter.acquireLock(lockPath)).rejects.toThrow();
      await release();
      const release2 = await platformAdapter.acquireLock(lockPath);
      await release2();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("launchDetachedSupervisor + verifyAlive + stopOwnedScope round-trip against a real long-lived process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-windows-adapter-test-"));
    const scriptPath = join(dir, "fake-supervisor.mjs");
    // A trivial script that stays alive until the process is terminated.
    await writeFile(scriptPath, `setInterval(() => {}, 1000);\n`, "utf8");

    const launch = await platformAdapter.launchDetachedSupervisor({
      supervisorEntry: scriptPath,
      argv: [],
      env: { ...process.env } as Record<string, string>,
      cwd: dir,
    });

    try {
      // Honest, weaker contract vs. the POSIX adapters: no job-object scope,
      // no real creation identity — this is the documented tradeoff of the
      // no-native-helper Windows path, not an oversight.
      expect(launch.ownershipScope).toBe("unverified");
      expect(launch.identity.creationIdentity).toBe("unavailable");
      expect(launch.identity.pid).toBeGreaterThan(0);
      expect(launch.ownershipHandle).toBe(String(launch.identity.pid));

      const aliveNow = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveNow).toBe(true);

      const stopOutcome = await platformAdapter.stopOwnedScope(launch.ownershipHandle, launch.ownershipScope, 2000);
      expect(stopOutcome.observedStopped).toBe(true);
      // Must NEVER claim tree verification on this path.
      expect(stopOutcome.verifiedNoDescendants).toBe(false);
      expect(stopOutcome.limitations.length).toBeGreaterThan(0);
      expect(stopOutcome.limitations.join(" ")).toMatch(/descendant/i);

      const aliveAfterStop = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveAfterStop).toBe(false);
    } finally {
      try {
        await platformAdapter.forceStopOwnedScope(String(launch.identity.pid), "unverified");
      } catch {
        // ignore
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("forceStopOwnedScope terminates a process and reports no-descendant-verification honestly", async () => {
    // NOTE on the Linux-as-proxy limitation this test itself documents:
    // windows.ts's forceStopOwnedScope relies on the documented Windows fact
    // that `process.kill(pid)` always maps to an unconditional TerminateProcess
    // regardless of any handler the target installs. On Linux (our proxy host)
    // `process.kill(pid)` with no signal defaults to SIGTERM, which IS
    // catchable/ignorable by the target — so a script that deliberately
    // swallows SIGTERM (as used in the POSIX adapters' equivalent "stubborn"
    // test) would not actually die here, even though it would on real
    // Windows. We therefore use a plain, non-signal-handling script so this
    // test can verify the Node-level call sequence and StopOutcome shape;
    // the "forceful regardless of handlers" guarantee itself is a
    // Windows-only property that cannot be verified on this host.
    const dir = await mkdtemp(join(tmpdir(), "agav-windows-adapter-force-test-"));
    const scriptPath = join(dir, "fake-supervisor-force.mjs");
    await writeFile(scriptPath, `setInterval(() => {}, 1000);\n`, "utf8");

    const launch = await platformAdapter.launchDetachedSupervisor({
      supervisorEntry: scriptPath,
      argv: [],
      env: { ...process.env } as Record<string, string>,
      cwd: dir,
    });

    try {
      const outcome = await platformAdapter.forceStopOwnedScope(launch.ownershipHandle, launch.ownershipScope);
      expect(outcome.observedStopped).toBe(true);
      expect(outcome.verifiedNoDescendants).toBe(false);
      expect(outcome.escalated).toBe(false);

      const aliveAfter = await platformAdapter.verifyAlive(launch.identity);
      expect(aliveAfter).toBe(false);
    } finally {
      try {
        await platformAdapter.forceStopOwnedScope(String(launch.identity.pid), "unverified");
      } catch {
        // ignore
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("stopOwnedScope/forceStopOwnedScope refuse an unsupported ownership scope rather than guessing", async () => {
    await expect(platformAdapter.stopOwnedScope("1234", "job-object", 100)).rejects.toThrow();
    await expect(platformAdapter.forceStopOwnedScope("1234", "process-group")).rejects.toThrow();
  });

  it("verifyAlive returns false for a pid that does not exist", async () => {
    const alive = await platformAdapter.verifyAlive({ pid: 999_999, creationIdentity: "unavailable" });
    expect(alive).toBe(false);
  });
});
