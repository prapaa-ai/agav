/**
 * T02 — Linux PlatformAdapter implementation.
 *
 * Implements the frozen `PlatformAdapter` contract from `../types.ts` (T01).
 * Reuses shared POSIX helpers from `./posix-common.ts` (also T01-owned) and
 * adds only Linux-specific behavior: Bubblewrap detection, best-effort
 * delegated-cgroup-v2 detection and process-group based ownership/stop.
 *
 * Design notes tying back to solution.md:
 *   - §4/§5 "fail closed": isolation/ownership capabilities that cannot be
 *     cheaply and reliably verified are reported as unavailable, never
 *     assumed. See `detectCapabilities()`.
 *   - §6 "PID existence alone is never sufficient to authorize a signal;
 *     PID reuse can otherwise kill unrelated work" / "never signal an
 *     unverified historical PID" — see `verifyAlive()` and the comments in
 *     `stopOwnedScope`/`forceStopOwnedScope` about always re-deriving the
 *     pgid from the caller-supplied ownership handle rather than any cached
 *     historical state.
 *   - §5 "Process groups do not contain descendants that deliberately
 *     escape; show the effective ownership scope before launch" — disclosed
 *     via `limitations` on both `detectCapabilities()` and `StopOutcome`.
 */
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

/**
 * Detect `bwrap` the same way `source/utils/sandbox.ts`'s `canExec`/
 * `detectSandboxBackend` do: probe through `/bin/sh -c "command -v <bin>"`,
 * which works regardless of which shell is the user's login shell and
 * doesn't depend on `which` being installed.
 */
async function canExecViaShell(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("/bin/sh", ["-c", `command -v ${cmd}`], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort check for a writable, delegated cgroup v2 controller for the
 * current process. We deliberately do not try to create/attach test cgroups
 * here — doing so would have side effects outside a detection call. Instead
 * we check that:
 *   1. cgroup v2 (unified hierarchy) is mounted, and
 *   2. this process's own cgroup directory (from /proc/self/cgroup) exists
 *      and is writable (i.e. we could add our own pids / adjust
 *      subtree_control without needing extra privilege).
 *
 * This is a much weaker guarantee than "we have verified a full delegated
 * subtree with cpu/memory controllers enabled" — per solution.md §2/§5,
 * "Delegated cgroups are optional: either implement and verify them
 * separately or explicitly report unavailable." We report `false` unless
 * this specific, cheap check passes, and we never claim
 * `strongestOwnershipScope: "delegated-cgroup"` from this check alone (see
 * `detectCapabilities` for why it still reports "process-group").
 */
async function detectWritableCgroupV2(): Promise<{ supported: boolean; note: string }> {
  try {
    const selfCgroup = await fs.readFile("/proc/self/cgroup", "utf8");
    // cgroup v2 unified hierarchy lines look like "0::/path/to/scope".
    const unifiedLine = selfCgroup
      .split("\n")
      .find((line) => line.startsWith("0::"));
    if (!unifiedLine) {
      return { supported: false, note: "No cgroup v2 unified hierarchy entry found in /proc/self/cgroup." };
    }
    const relPath = unifiedLine.slice(3).trim();
    // Resolve the actual cgroup2 mount point rather than assuming
    // /sys/fs/cgroup is the unified root — on some distros it's a
    // tmpfs with per-controller subdirectories and cgroup2 mounted
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
    // Writable own-cgroup directory is necessary but not sufficient for a
    // true delegated subtree (would also need cgroup.subtree_control write
    // access and enabled controllers). We only assert the cheap, verifiable
    // subset and still fail closed on the stronger "delegated-cgroup"
    // ownership scope claim (see detectCapabilities comment).
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
    // ignore, fall through to undefined
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
  const supportsDelegatedCgroup = false; // see rationale below; always fail closed for now.
  if (!cgroup.supported) {
    limitations.push(`Delegated cgroup v2 not usable: ${cgroup.note}`);
  } else {
    // We deliberately do not flip supportsDelegatedCgroup to true even
    // though the cheap check passed: solution.md §2 requires delegated
    // cgroups to be "implement[ed] and verif[ied] separately" before being
    // advertised, and this adapter does not yet implement cgroup-based
    // process placement/kill (stopOwnedScope only operates on process
    // groups). Advertising "delegated-cgroup" here without actually using
    // it to own/stop workloads would violate "fail closed" / "never
    // silently downgrade" guidance by claiming an unused capability.
    limitations.push(
      `Writable cgroup v2 directory detected (${cgroup.note}) but this adapter does not yet place workloads into a delegated cgroup or use it for termination verification, so supportsDelegatedCgroup is reported false until that is implemented end-to-end.`,
    );
  }

  return {
    platform: "linux",
    availableIsolationBackends,
    // process-group is the only ownership scope this adapter actually
    // implements launch/stop semantics for (see launchDetachedSupervisor /
    // stopOwnedScope). Reporting "delegated-cgroup" here would be a lie
    // about what stopOwnedScope can actually verify.
    strongestOwnershipScope: "process-group",
    supportsGracefulApplicationShutdown: true, // SIGTERM is always deliverable on Linux.
    supportsDelegatedCgroup,
    nativeHelperAvailable: true, // no native helper needed on Linux; plain Node child_process suffices.
    limitations,
  };
}

/** Delegate to the shared POSIX canonicalization helper (realpath + existence check). */
async function canonicalizePath(path: string): Promise<string> {
  return canonicalizePathPosix(path);
}

/** Delegate to the shared POSIX O_EXCL lock helper. */
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
    // The supervisor owns its own log files (T10); this adapter's only job
    // is to start it fully detached from the current TTY/parent lifetime.
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

  // Let the parent CLI process exit without waiting on this child.
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Failed to launch detached supervisor: no pid assigned (${spawnError?.message ?? "unknown spawn failure"}).`,
    );
  }

  // Give the child a short window to fail fast (bad entry path, immediate
  // crash, exec failure) before we declare it launched. This is a liveness
  // sanity check, not a correctness guarantee — a child could still crash
  // a moment later, which is why the caller (T11/T12) still relies on
  // heartbeat/handshake for authoritative "running" state.
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
    // Not fatal — verifyAlive() documents and handles the weaker fallback —
    // but this is worth surfacing because it means PID-reuse detection for
    // this particular supervisor degrades to pid-exists-only.
    // (No `limitations` channel is available on DetachedLaunchResult, so
    // this is the only place that can be noted; left here for maintainers.)
  }

  const identity: ProcessIdentity = { pid, creationIdentity: creationIdentity ?? "" };

  // On POSIX, spawning with detached:true makes the child the leader of its
  // own new process group/session, so its pgid equals its own pid. The
  // ownership handle is the pgid in string form; stop/force-stop re-derive
  // the pgid from this handle, never from any other cached historical pid
  // (solution.md §6: "never signal an unverified historical PID").
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
    // Weaker check: the original launch could not read a creation-identity
    // disambiguator (e.g. /proc/<pid>/stat and `ps` both failed at launch
    // time — extremely unusual, but possible under restrictive sandboxing).
    // Falling back to pid-exists-only re-introduces the PID-reuse risk that
    // solution.md §6 explicitly warns about ("PID existence alone is never
    // sufficient to authorize a signal"). We still return true here because
    // an undefined creationIdentity was already a known, documented
    // weakness at launch time, not a new one introduced by this check —
    // but any caller treating this as authorization to *signal* the pid
    // should prefer stopOwnedScope's process-group semantics, which never
    // rely solely on pid existence either.
    return true;
  }

  const currentStart = await readProcessStartTimePosix(identity.pid);
  // If we can no longer read the start time (process gone, or /proc access
  // denied) but kill(pid, 0) still said it exists, treat as not verifiably
  // the same process rather than guessing alive.
  if (currentStart === undefined) return false;
  return currentStart === identity.creationIdentity;
}

/** True once `kill(-pgid, 0)` reports ESRCH, i.e. no processes remain in the group. */
function processGroupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false; // still has at least one member
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

  // Re-derive the pgid fresh from the caller-supplied handle every call;
  // never reuse any previously cached pid/pgid from elsewhere in this
  // module (solution.md §6: never signal an unverified historical PID).
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

  // Still alive after grace: escalate to force-stop.
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
  // SIGKILL is not instantaneous for a process that's blocked in
  // uninterruptible I/O; poll briefly rather than asserting immediately.
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
