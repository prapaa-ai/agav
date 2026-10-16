import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
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

/**
 * Cheap check only: cgroup v2 is mounted and our own cgroup dir is writable. No test
 * cgroups are created (detection must be side-effect free), so this does not prove
 * a delegated subtree with controllers.
 */
async function detectWritableCgroupV2(): Promise<{ supported: boolean; note: string }> {
  try {
    const selfCgroup = await fs.readFile("/proc/self/cgroup", "utf8");
    // Unified hierarchy line: "0::/path/to/scope".
    const unifiedLine = selfCgroup
      .split("\n")
      .find((line) => line.startsWith("0::"));
    if (!unifiedLine) {
      return { supported: false, note: "No cgroup v2 unified hierarchy entry found in /proc/self/cgroup." };
    }
    const relPath = unifiedLine.slice(3).trim();
    // Don't assume /sys/fs/cgroup is the unified root; some distros mount cgroup2
    // separately (e.g. /sys/fs/cgroup/unified).
    const mountPoint = await findCgroup2MountPoint();
    if (!mountPoint) {
      return { supported: false, note: "No cgroup2 filesystem mount found; delegated cgroups unavailable." };
    }
    const dir = `${mountPoint}${relPath}`;
    try {
      await fs.access(dir, fs.constants.W_OK);
    } catch {
      return { supported: false, note: `Own cgroup directory (${dir}) is not writable by this process.` };
    }
    // Necessary but not sufficient: subtree_control access and controllers are unchecked.
    return { supported: true, note: `Writable cgroup v2 directory detected at ${dir}; full controller delegation not independently verified.` };
  } catch {
    return { supported: false, note: "Could not read /proc/self/cgroup; delegated cgroups unavailable." };
  }
}

async function findCgroup2MountPoint(): Promise<string | undefined> {
  try {
    const mounts = await fs.readFile("/proc/self/mounts", "utf8");
    for (const line of mounts.split("\n")) {
      const fields = line.split(" ");
      if (fields[2] === "cgroup2") return fields[1];
    }
  } catch {
    // unreadable: treat as no cgroup2 mount
  }
  return undefined;
}

async function detectCapabilities(): Promise<PlatformCapabilities> {
  const limitations: string[] = [];
  const availableIsolationBackends: IsolationBackend[] = [];

  const bwrapAvailable = await canExecViaShell("bwrap");
  if (bwrapAvailable) {
    availableIsolationBackends.push("bubblewrap");
  } else {
    limitations.push("Bubblewrap (bwrap) binary not found on PATH; 'bubblewrap' isolation backend is unavailable.");
  }

  const cgroup = await detectWritableCgroupV2();
  const supportsDelegatedCgroup = false; // fail closed: no cgroup-based placement/kill is implemented
  if (!cgroup.supported) {
    limitations.push(`Delegated cgroup v2 not usable: ${cgroup.note}`);
  } else {
    // Stays false even when the cheap check passes: stopOwnedScope only handles process groups.
    limitations.push(
      `Writable cgroup v2 directory detected (${cgroup.note}) but this adapter does not yet place workloads into a delegated cgroup or use it for termination verification, so supportsDelegatedCgroup is reported false until that is implemented end-to-end.`,
    );
  }

  return {
    platform: "linux",
    availableIsolationBackends,
    strongestOwnershipScope: "process-group",
    supportsGracefulApplicationShutdown: true,
    supportsDelegatedCgroup,
    nativeHelperAvailable: true,
    limitations,
  };
}

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
    // Launch couldn't read a start time (/proc and `ps` both failed): pid-exists-only,
    // which re-introduces PID-reuse risk. Don't treat this as authorization to signal the pid.
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
  "Process groups do not contain descendants that deliberately escape (double-forking, setsid, re-parenting); such descendants are not covered by this stop/force-stop verification (solution.md §5).";

function parsePgid(ownershipHandle: string, ownershipScope: ProcessOwnershipScope): number {
  if (ownershipScope !== "process-group") {
    throw new BackgroundJobError(
      "unsupported-platform",
      `Linux adapter only supports ownershipScope "process-group"; got "${ownershipScope}".`,
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
  platform: "linux",
  detectCapabilities,
  canonicalizePath,
  acquireLock,
  launchDetachedSupervisor,
  verifyAlive,
  stopOwnedScope,
  forceStopOwnedScope,
};
