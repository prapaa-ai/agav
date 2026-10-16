// Fail-closed Windows adapter: not exercised on Windows, and no native Job Object
// helper is bundled. Stock Node cannot create/assign Job Objects, so this adapter
// reports `nativeHelperAvailable: false` and ownership scope "unverified", and only
// ever signals the single supervisor pid (never walks or kills a tree by PID).
// It reports `availableIsolationBackends: []`, but cannot enforce isolation policy:
// callers requiring isolation must refuse based on that empty list.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
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

const LIMITATIONS: readonly string[] = [
  "No native Windows Job Object helper binary is bundled in this delivery (no C/C++ toolchain target in this environment; see README.md's recorded T04 decision). " +
    "Job Object tree ownership (suspended launch, AssignProcessToJobObject, ResumeThread) is therefore unavailable.",
  "Without a Job Object, this adapter can only track a single supervisor pid. PID-based process trees are not a trustworthy ownership boundary " +
    "(solution.md §5: 'No workload breakaway' requires a Job handle this adapter does not hold) — launches that require isolation.required or an " +
    "ownershipScope stronger than \"unverified\" are refused outright rather than silently downgraded to raw PID killing (solution.md §5/§12).",
  "Job Objects are an ownership/resource control, not a filesystem/network sandbox (solution.md §5); this adapter reports zero available isolation " +
    "backends on Windows regardless of Job Object availability.",
  "Graceful application shutdown (a configured close/shutdown message) requires the native helper's cooperation with the target process; Node has no " +
    "portable way to deliver that without it, so this adapter only ever offers forced termination and discloses that honestly rather than claiming a " +
    "graceful-shutdown capability it cannot deliver.",
  "Process-creation time (Windows CreationTime) is not exposed by Node's public API without native bindings; this adapter cannot populate a reliable " +
    "`creationIdentity`, so PID-reuse protection is weaker here than on the POSIX adapters (see launchDetachedSupervisor/verifyAlive).",
];

async function detectCapabilities(): Promise<PlatformCapabilities> {
  const nativeHelperAvailable = false;

  const availableIsolationBackends: IsolationBackend[] = [];

  return {
    platform: "win32",
    availableIsolationBackends,
    // Without a Job Object, tree membership can't be verified at all.
    strongestOwnershipScope: "unverified",
    supportsGracefulApplicationShutdown: false,
    supportsDelegatedCgroup: false,
    nativeHelperAvailable,
    limitations: [...LIMITATIONS],
  };
}

/**
 * Known limitation: NTFS is case-insensitive but case-preserving and case is not
 * normalized here; callers needing case-canonical comparison must fold case themselves.
 */
async function canonicalizePath(path: string): Promise<string> {
  return realpath(path);
}

/**
 * O_EXCL lock file (never deleted/replaced while held, never seized by age); on
 * EEXIST throws `lock-held`. The holder record has no `processStartTime` (no Windows
 * probe without a native addon), so stale recovery can only prove "gone" when the pid
 * no longer exists; a reused pid keeps the lock held, which fails safe.
 *
 * Sharing violations (antivirus/indexer holding a handle, or a lock file pending
 * deletion) surface as EBUSY/EPERM/EACCES; create and release retry them with bounded
 * backoff, then rethrow the original error (never translated to success or `lock-held`).
 */
const SHARING_VIOLATION_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);
const SHARING_VIOLATION_RETRY_DELAYS_MS: readonly number[] = [10, 25, 50, 100, 200];

async function withSharingViolationRetry<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = SHARING_VIOLATION_RETRY_DELAYS_MS[attempt];
      if (code === undefined || !SHARING_VIOLATION_CODES.has(code) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await fs.mkdir(dirname(path), { recursive: true });
  let handle: fs.FileHandle;
  try {
    handle = await withSharingViolationRetry(() =>
      fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY),
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      throw new BackgroundJobError("lock-held", `Lock already held: ${path}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), hostname: hostname() }),
    );
  } finally {
    await handle.close();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await withSharingViolationRetry(() => fs.unlink(path)).catch(() => {});
  };
}

const SPAWN_SETTLE_MS = 80;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
    stdio: "ignore",
    cwd,
    env,
    windowsHide: true,
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

  // Fail-fast window only; not a liveness guarantee.
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

  // Known limitation: with no Job Object we report "unverified", not "job-object";
  // the handle is just the bare pid.
  const ownershipHandle = String(pid);

  // Process creation time isn't available without a native addon, so PID-reuse
  // protection here is weaker than on POSIX.
  const identity: ProcessIdentity = { pid, creationIdentity: "unavailable" };

  return {
    identity,
    ownershipHandle,
    ownershipScope: "unverified",
  };
}

/**
 * Existence-only check (`creationIdentity` is always "unavailable"), so a recycled pid
 * is wrongly reported alive. Known limitation, disclosed in `limitations`.
 */
async function verifyAlive(identity: ProcessIdentity): Promise<boolean> {
  try {
    process.kill(identity.pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // EPERM: exists but not signalable by us.
    if (err.code === "EPERM") return true;
    return false;
  }
}

async function waitForPidGone(pid: number, graceMs: number): Promise<boolean> {
  const pollIntervalMs = 100;
  const deadline = Date.now() + graceMs;
  const stillAlive = async () => verifyAlive({ pid, creationIdentity: "unavailable" });
  if (!(await stillAlive())) return true;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    if (!(await stillAlive())) return true;
  }
  return !(await stillAlive());
}

// Attached to every StopOutcome so a single-process kill is never mistaken for tree ownership.
const TREE_LIMITATION =
  "No Windows Job Object is available on this path, so only the single supervisor process identified by its pid was targeted. " +
  "Child/descendant processes spawned by the workload are NOT guaranteed to be terminated (no Job Object tree kill available). " +
  "This adapter deliberately does not walk or kill a process tree by PID — a PID-walk fallback would masquerade as tree ownership " +
  "it does not have (solution.md §5/§12).";

function parsePid(ownershipHandle: string): number {
  const pid = Number(ownershipHandle);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new BackgroundJobError("not-found", `Invalid Windows ownership handle: "${ownershipHandle}".`);
  }
  return pid;
}

function assertSupportedScope(ownershipScope: ProcessOwnershipScope): void {
  // A "job-object" scope would imply a native helper this build lacks; refuse rather than guess.
  if (ownershipScope !== "unverified") {
    throw new BackgroundJobError(
      "unsupported-platform",
      `Windows adapter (no native helper in this delivery) only supports ownershipScope "unverified"; got "${ownershipScope}". ` +
        `Job Object tree ownership is not implemented — see detectCapabilities().limitations.`,
    );
  }
}

/**
 * Windows has no graceful signal Node can deliver: `process.kill(pid)` is always
 * TerminateProcess. Stop and force-stop therefore do the same single-pid kill;
 * stop just polls up to `graceMs` to observe it.
 */
async function stopOwnedScope(
  ownershipHandle: string,
  ownershipScope: ProcessOwnershipScope,
  graceMs: number,
): Promise<StopOutcome> {
  assertSupportedScope(ownershipScope);
  const pid = parsePid(ownershipHandle);

  try {
    process.kill(pid);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") throw error; // ESRCH: already gone, fine.
  }

  const observedStopped = await waitForPidGone(pid, graceMs);

  return {
    observedStopped,
    escalated: false,
    // Never inferred from the single-pid check: no tree accounting without a Job Object.
    verifiedNoDescendants: false,
    limitations: [TREE_LIMITATION],
  };
}

async function forceStopOwnedScope(
  ownershipHandle: string,
  ownershipScope: ProcessOwnershipScope,
): Promise<StopOutcome> {
  assertSupportedScope(ownershipScope);
  const pid = parsePid(ownershipHandle);

  try {
    process.kill(pid);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") throw error;
  }

  const observedStopped = await waitForPidGone(pid, 1000);

  return {
    observedStopped,
    escalated: false,
    verifiedNoDescendants: false,
    limitations: [TREE_LIMITATION],
  };
}

export const platformAdapter: PlatformAdapter = {
  platform: "win32",
  detectCapabilities,
  canonicalizePath,
  acquireLock,
  launchDetachedSupervisor,
  verifyAlive,
  stopOwnedScope,
  forceStopOwnedScope,
};
