// Not exercised on macOS CI; written against documented macOS/POSIX behavior.
import { spawn } from "node:child_process";
import {
  canonicalizePathPosix,
  acquireExclusiveLockPosix,
  readProcessStartTimePosix,
  pidExistsPosix,
  signalProcessGroup,
  sleep,
} from "./posix-common.js";
import {
  BackgroundJobError,
  PreSpawnLaunchError,
  type PlatformAdapter,
  type PlatformCapabilities,
  type ProcessIdentity,
  type DetachedLaunchResult,
  type StopOutcome,
  type ProcessOwnershipScope,
  type IsolationBackend,
} from "../types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Probes via `/bin/sh -c "command -v"` so it works for any login shell and without `which`.
async function canExecViaShell(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("/bin/sh", ["-c", `command -v ${cmd}`], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const SEATBELT_LIMITATION =
  "Seatbelt (sandbox-exec) availability was detected only by resolving the binary on PATH. Apple has deprecated sandbox-exec's public interface, its profile-language behavior is undocumented/unstable and varies across macOS releases, and this detection does not independently verify that any specific Seatbelt policy used by this feature is accepted on the host's macOS version (solution.md §5: \"Validate supported Seatbelt tooling/policy; acknowledge tooling deprecation/availability limitations\").";

const NO_CGROUP_LIMITATION =
  "macOS has no cgroup or portable equivalent; delegated-cgroup ownership/stop verification is not and cannot be implemented on this platform (solution.md §5 \"Strong stop\" row: \"no portable cgroup equivalent\"). supportsDelegatedCgroup is unconditionally false; this is a platform fact, not a detection failure.";

async function detectCapabilities(): Promise<PlatformCapabilities> {
  const limitations: string[] = [NO_CGROUP_LIMITATION];
  const availableIsolationBackends: IsolationBackend[] = [];

  const seatbeltBinaryFound = await canExecViaShell("sandbox-exec");
  if (seatbeltBinaryFound) {
    // Binary resolving is all we verify; the limitation text discloses the rest.
    availableIsolationBackends.push("seatbelt");
    limitations.push(SEATBELT_LIMITATION);
  } else {
    limitations.push("sandbox-exec binary not found on PATH; 'seatbelt' isolation backend is unavailable.");
  }

  return {
    platform: "darwin",
    availableIsolationBackends,
    strongestOwnershipScope: "process-group",
    supportsGracefulApplicationShutdown: true,
    supportsDelegatedCgroup: false, // cgroups don't exist on macOS; nothing to probe
    nativeHelperAvailable: true,
    limitations,
  };
}

/**
 * Known limitation: default APFS volumes are case-insensitive but case-preserving,
 * and `realpath` does not normalize case, so paths differing only in case can
 * resolve to different strings. Callers needing case-canonical comparison must
 * fold case themselves.
 */
async function canonicalizePath(path: string): Promise<string> {
  return canonicalizePathPosix(path);
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  return acquireExclusiveLockPosix(path);
}

const SPAWN_SETTLE_MS = 80;

async function launchDetachedSupervisor(args: {
  supervisorEntry: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}): Promise<DetachedLaunchResult> {
  const { supervisorEntry, argv, env, cwd } = args;

  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;

  const child = spawn(process.execPath, [supervisorEntry, ...argv], {
    detached: true,
    // The supervisor owns its own log files.
    stdio: "ignore",
    cwd,
    env,
  });

  child.once("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });
  child.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });

  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    // Node assigns no pid only when the OS refused to create the process (ENOENT, EACCES, EAGAIN...),
    // so nothing ran: a definite failure the coordinator may release capacity for.
    throw new PreSpawnLaunchError(
      "storage-unavailable",
      `Failed to launch detached supervisor: no pid assigned (${spawnError?.message ?? "unknown spawn failure"}).`,
    );
  }

  // Short window to catch fail-fast launches (bad entry path, exec failure). Not a
  // guarantee: callers still rely on heartbeat/handshake for authoritative state.
  await sleep(SPAWN_SETTLE_MS);

  if (spawnError) {
    throw new BackgroundJobError("storage-unavailable", `Failed to launch detached supervisor: ${spawnError.message}`);
  }
  if (earlyExit) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Detached supervisor exited immediately (code=${earlyExit.code}, signal=${earlyExit.signal}) before confirming it was alive.`,
    );
  }

  // On macOS this resolves via the `ps` fallback (no /proc).
  const creationIdentity = await readProcessStartTimePosix(pid);
  if (creationIdentity === undefined) {
    // Not fatal, but PID-reuse detection for this supervisor degrades to pid-exists-only
    // (DetachedLaunchResult has no `limitations` channel to report it).
  }

  const identity: ProcessIdentity = { pid, creationIdentity: creationIdentity ?? "" };

  // detached:true makes the child its own group leader, so pgid == pid.
  const ownershipHandle = String(pid);

  return {
    identity,
    ownershipHandle,
    ownershipScope: "process-group",
  };
}

async function verifyAlive(identity: ProcessIdentity): Promise<boolean> {
  if (!(await pidExistsPosix(identity.pid))) return false;

  if (!identity.creationIdentity) {
    // Launch couldn't read a start time (e.g. `ps` failed): pid-exists-only, which
    // re-introduces PID-reuse risk.
    return true;
  }

  const currentStart = await readProcessStartTimePosix(identity.pid);
  // Unreadable now although the pid exists: treat as not verifiably the same process.
  if (currentStart === undefined) return false;
  return currentStart === identity.creationIdentity;
}

function processGroupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return true;
    if (err.code === "EPERM") return false; // exists, just not signalable by us
    throw error;
  }
}

async function waitForGroupEmpty(pgid: number, graceMs: number): Promise<boolean> {
  const pollIntervalMs = 100;
  const deadline = Date.now() + graceMs;
  if (processGroupIsEmpty(pgid)) return true;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    if (processGroupIsEmpty(pgid)) return true;
  }
  return processGroupIsEmpty(pgid);
}

const ESCAPE_LIMITATION =
  "Process groups do not contain descendants that deliberately escape (double-forking, setsid, re-parenting, launchd re-adoption); such descendants are not covered by this stop/force-stop verification, and macOS has no portable cgroup-equivalent to independently verify an empty descendant set (solution.md §5 \"Strong stop\" row: \"Group stop with escape caveat; no portable cgroup equivalent\").";

function parsePgid(ownershipHandle: string, ownershipScope: ProcessOwnershipScope): number {
  if (ownershipScope !== "process-group") {
    throw new BackgroundJobError(
      "unsupported-platform",
      `macOS adapter only supports ownershipScope "process-group"; got "${ownershipScope}".`,
    );
  }
  const pgid = Number(ownershipHandle);
  if (!Number.isInteger(pgid) || pgid <= 0) {
    throw new BackgroundJobError("not-found", `Invalid process-group ownership handle: "${ownershipHandle}".`);
  }
  return pgid;
}

async function stopOwnedScope(
  ownershipHandle: string,
  ownershipScope: ProcessOwnershipScope,
  graceMs: number,
): Promise<StopOutcome> {
  const pgid = parsePgid(ownershipHandle, ownershipScope);

  // The pgid is always re-derived from the caller's handle, never a cached historical pid.
  signalProcessGroup(pgid, "SIGTERM");

  const emptyAfterGrace = await waitForGroupEmpty(pgid, graceMs);
  if (emptyAfterGrace) {
    return {
      observedStopped: true,
      escalated: false,
      verifiedNoDescendants: true,
      limitations: [ESCAPE_LIMITATION],
    };
  }

  const forced = await forceStopOwnedScope(ownershipHandle, ownershipScope);
  return {
    observedStopped: forced.observedStopped,
    escalated: true,
    verifiedNoDescendants: forced.verifiedNoDescendants,
    limitations: forced.limitations,
  };
}

async function forceStopOwnedScope(
  ownershipHandle: string,
  ownershipScope: ProcessOwnershipScope,
): Promise<StopOutcome> {
  const pgid = parsePgid(ownershipHandle, ownershipScope);

  signalProcessGroup(pgid, "SIGKILL");
  // SIGKILL isn't instant for processes in uninterruptible I/O; poll briefly.
  const verified = await waitForGroupEmpty(pgid, 1000);

  return {
    observedStopped: verified,
    escalated: false,
    verifiedNoDescendants: verified,
    limitations: [ESCAPE_LIMITATION],
  };
}

export const platformAdapter: PlatformAdapter = {
  platform: "darwin",
  detectCapabilities,
  canonicalizePath,
  acquireLock,
  launchDetachedSupervisor,
  verifyAlive,
  stopOwnedScope,
  forceStopOwnedScope,
};
