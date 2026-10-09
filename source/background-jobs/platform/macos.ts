/**
 * T03 — macOS PlatformAdapter implementation.
 *
 * NOTE: implemented against documented macOS/POSIX behavior; not executed on
 * macOS. See T03 handoff report for verification limitations.
 *
 * Implements the frozen `PlatformAdapter` contract from `../types.ts` (T01).
 * Reuses shared POSIX helpers from `./posix-common.ts` (also T01-owned,
 * shared with T02's `linux.ts` per that file's header comment: "Coordinate
 * shared POSIX primitives through T01's owner rather than editing T02's
 * files"). This module adds only macOS-specific behavior: Seatbelt
 * (`sandbox-exec`) detection and documentation of macOS-specific caveats
 * (no cgroup equivalent, APFS case-insensitive-but-case-preserving default
 * volumes). Process-group launch/stop/verify logic is the "same POSIX
 * baseline" referenced in solution.md §5 and is intentionally implemented
 * the same way as T02's `linux.ts`, not duplicated with divergent logic.
 *
 * Design notes tying back to solution.md:
 *   - §5 table, "Isolation" row: "Validate supported Seatbelt tooling/policy;
 *     acknowledge tooling deprecation/availability limitations." Apple has
 *     been progressively deprecating/restricting `sandbox-exec` and its
 *     profile-language behavior differs across OS releases, so this adapter
 *     only ever asserts "the binary resolves on PATH", never "the profile
 *     syntax this repo uses is guaranteed to be accepted" — see
 *     `detectCapabilities()`.
 *   - §5 table, "Workload ownership" row: "Separate process group; disclose
 *     that daemonized/escaped descendants are outside the baseline."
 *   - §5 table, "Strong stop" row: "Group stop with escape caveat; no
 *     portable cgroup equivalent." — macOS has no cgroups at all, so
 *     `supportsDelegatedCgroup` is unconditionally `false` here (no probing
 *     needed, unlike Linux's cheap-but-inconclusive cgroup v2 check).
 *   - §5 table, "Filesystem and access" row: "Same, including symlink and
 *     filesystem casing considerations." — see `canonicalizePath()`.
 *   - §6 "PID existence alone is never sufficient to authorize a signal" and
 *     "never signal an unverified historical PID" — see `verifyAlive()` and
 *     `stopOwnedScope`/`forceStopOwnedScope`, which re-derive the pgid from
 *     the caller-supplied ownership handle every call, matching T02.
 */
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
 * Detect `sandbox-exec` the same way `source/utils/sandbox.ts`'s `canExec`/
 * `detectSandboxBackend` do: probe through `/bin/sh -c "command -v <bin>"`,
 * which works regardless of which shell is the user's login shell and
 * doesn't depend on `which` being installed. Kept as its own local copy
 * (rather than importing source/utils/sandbox.ts) because that module is
 * owned by existing CLI sandboxing code, not this subsystem's platform
 * adapters — the two are independent probes that happen to use the same
 * detection style, not a shared dependency.
 */
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
    // Report the backend as available only because the binary resolves;
    // still disclose the deprecation/version-variance caveat per
    // solution.md §5 rather than implying full policy-compatibility
    // verification happened.
    availableIsolationBackends.push("seatbelt");
    limitations.push(SEATBELT_LIMITATION);
  } else {
    limitations.push("sandbox-exec binary not found on PATH; 'seatbelt' isolation backend is unavailable.");
  }

  return {
    platform: "darwin",
    availableIsolationBackends,
    // process-group is the only ownership scope this adapter actually
    // implements launch/stop semantics for, matching the Linux adapter and
    // solution.md §5's "Same POSIX baseline" / "Separate process group"
    // guidance for macOS workload ownership.
    strongestOwnershipScope: "process-group",
    supportsGracefulApplicationShutdown: true, // SIGTERM is always deliverable on macOS/POSIX.
    // Unconditionally false: cgroups do not exist on macOS at all, so there
    // is nothing to probe (unlike Linux's cheap writable-cgroup-v2 check
    // which still fails closed on the stronger claim). See
    // NO_CGROUP_LIMITATION above.
    supportsDelegatedCgroup: false,
    // No native helper is required for basic process-group ownership on
    // macOS — the same plain Node child_process POSIX baseline as Linux
    // suffices (solution.md §5 "Same POSIX baseline").
    nativeHelperAvailable: true,
    limitations,
  };
}

/**
 * Delegate to the shared POSIX canonicalization helper (realpath + existence
 * check) — POSIX symlink-resolution semantics are identical on macOS.
 *
 * Filesystem casing caveat (solution.md §5 "Filesystem and access" row:
 * "Same, including symlink and filesystem casing considerations"): macOS's
 * default APFS volume is case-insensitive but case-preserving. `realpath`
 * on such a volume does NOT normalize/correct the casing of path segments
 * that differ only in case from what's actually on disk — it resolves
 * symlinks and relative segments, but two paths that differ only in case
 * (e.g. "/Users/me/Project" vs "/Users/me/project") can both resolve
 * successfully to filesystem-equivalent-but-string-different results
 * depending on what was passed in, because APFS case-insensitive lookup
 * accepts either spelling while preserving whichever casing was used at
 * create time. This adapter deliberately does NOT attempt to "fix" or
 * normalize case here — doing so would require macOS-specific
 * directory-entry enumeration this adapter cannot verify from this sandbox,
 * and silently rewriting a caller-supplied path's case could mask a
 * genuine mismatch. Callers that need case-canonical comparison (e.g. spec
 * hashing, duplicate-path detection) must apply their own additional
 * case-folding/comparison logic on top of this helper's result; this
 * function only resolves symlinks and verifies existence, like its Linux
 * counterpart.
 */
async function canonicalizePath(path: string): Promise<string> {
  return canonicalizePathPosix(path);
}

/** Delegate to the shared POSIX O_EXCL lock helper — identical semantics on macOS. */
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
  // heartbeat/handshake for authoritative "running" state. Same approach
  // and rationale as the Linux adapter.
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

  // readProcessStartTimePosix first tries the Linux-only /proc/<pid>/stat
  // path, which does not exist on macOS and will throw/be caught internally
  // — that failure is expected and intentional on this platform (there is
  // no macOS-specific code needed here; the existing try/catch in
  // posix-common.ts already falls through). The function then falls back to
  // the portable `ps -o lstart= -p <pid>` probe, which is the branch that
  // actually executes and succeeds on macOS, giving a best-effort creation
  // timestamp used to disambiguate PID reuse.
  const creationIdentity = await readProcessStartTimePosix(pid);
  if (creationIdentity === undefined) {
    // Not fatal — verifyAlive() documents and handles the weaker fallback —
    // but this is worth surfacing because it means PID-reuse detection for
    // this particular supervisor degrades to pid-exists-only. (No
    // `limitations` channel is available on DetachedLaunchResult, so this
    // is the only place that can be noted; left here for maintainers, same
    // as the Linux adapter.)
  }

  const identity: ProcessIdentity = { pid, creationIdentity: creationIdentity ?? "" };

  // On POSIX, spawning with detached:true makes the child the leader of its
  // own new process group/session, so its pgid equals its own pid — true on
  // macOS as on Linux. The ownership handle is the pgid in string form;
  // stop/force-stop re-derive the pgid from this handle, never from any
  // other cached historical pid (solution.md §6: "never signal an
  // unverified historical PID").
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
    // disambiguator (e.g. `ps -o lstart=` failed at launch time — extremely
    // unusual, but possible under restrictive sandboxing). Falling back to
    // pid-exists-only re-introduces the PID-reuse risk that solution.md §6
    // explicitly warns about ("PID existence alone is never sufficient to
    // authorize a signal"). Same documented tradeoff as the Linux adapter.
    return true;
  }

  const currentStart = await readProcessStartTimePosix(identity.pid);
  // If we can no longer read the start time (process gone, or the `ps`
  // probe failed) but kill(pid, 0) still said it exists, treat as not
  // verifiably the same process rather than guessing alive.
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

  // Re-derive the pgid fresh from the caller-supplied handle every call;
  // never reuse any previously cached pid/pgid from elsewhere in this
  // module (solution.md §6: never signal an unverified historical PID).
  // Same group strategy as the Linux adapter (solution.md §5 "Graceful
  // stop" row: "Same group strategy").
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
  platform: "darwin",
  detectCapabilities,
  canonicalizePath,
  acquireLock,
  launchDetachedSupervisor,
  verifyAlive,
  stopOwnedScope,
  forceStopOwnedScope,
};
