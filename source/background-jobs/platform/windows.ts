/**
 * T04 — Windows PlatformAdapter implementation (fail-closed, no native
 * helper bundled in this delivery).
 *
 * NOTE: implemented against documented Node.js/Windows API behavior; not
 * executed on Windows, and no native Job Object helper binary is bundled in
 * this delivery. See T04 handoff report for what remains for a
 * production-grade Windows implementation (native helper, suspended-launch
 * +Job-assign+resume, tree termination, nested-Job incompatibility
 * detection).
 *
 * Per README.md (T01's recorded decision) and solution.md §5/§7:
 *   "The Windows native helper (T04) is out of scope for a C/C++ binary in
 *   this environment; it is implemented as a Node-based helper using
 *   node:child_process Job Object bindings where available, with explicit
 *   capability-reporting fallback to refusal (nativeHelperAvailable: false)
 *   when the binding is missing."
 *
 * There is, in fact, no `node:child_process` Job Object binding available in
 * stock Node.js today (Node does not expose CreateJobObject/AssignProcessTo
 * JobObject/ResumeThread anywhere in its public API surface). This file
 * therefore always takes the documented fallback branch: it reports
 * `nativeHelperAvailable: false` and refuses to claim any ownership scope
 * stronger than "unverified".
 *
 * solution.md §5 (Windows column) requires:
 *   - Workload ownership: "Native helper owns a Job Object; launch
 *     suspended, assign, then resume. No workload breakaway." — NOT done
 *     here; see detectCapabilities().limitations.
 *   - Graceful stop: "Configured application shutdown where supported;
 *     otherwise disclose forced termination. POSIX signal names are not a
 *     graceful Windows contract." — we disclose forced-only termination.
 *   - Strong stop: "Job Object tree termination and observed active-process
 *     accounting." — NOT available without the native helper; this adapter
 *     can only terminate the single supervisor pid it was given.
 *   - Isolation: "Job Objects are ownership/resource controls, not
 *     filesystem/network sandboxes." — this adapter reports zero available
 *     isolation backends; see detectCapabilities().
 *
 * solution.md §5 closing paragraph: "Incompatible inherited/nested Jobs make
 * launch unavailable, not a reason to fall back to raw PID killing." and §12:
 * "Replace raw PID/log-inactivity reconciliation... No POSIX-signal or
 * PID-walk fallback masquerades as tree ownership." This file follows that
 * directive literally: it never walks or kills a process *tree* by PID. It
 * only ever signals the single supervisor process identified by its own
 * ownership handle, and it reports `verifiedNoDescendants: false` and a
 * loud limitation every single time, rather than ever claiming tree
 * ownership it cannot back up.
 *
 * Defensive note for callers (mainly T08's authorization service): this
 * adapter's `detectCapabilities()` always reports `availableIsolationBackends:
 * []`. Per solution.md §4 ("Determine the actual isolation backend before
 * approval. Required isolation unavailable means refusal."), any caller
 * requesting `isolation.required` with a backend other than "none" MUST fail
 * closed itself using this reported empty list — this adapter does not (and
 * architecturally cannot, per the PlatformAdapter contract in types.ts)
 * independently enforce isolation policy; it only ever reports what is
 * available.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
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

// ---------------------------------------------------------------------------
// Capability reporting (solution.md §5/§7, README.md's recorded T04 decision)
// ---------------------------------------------------------------------------

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
  // No Job Object binding exists in stock node:child_process; always take
  // the documented refusal/fallback path rather than ever guessing "maybe
  // available" (solution.md §4: "fail closed... never silently assume").
  const nativeHelperAvailable = false;

  // Job Objects are ownership controls, not isolation/sandbox backends
  // (solution.md §5 Windows row, "Isolation" concern) — this adapter never
  // reports anything here, so any caller requesting isolation.required with
  // backend !== "none" must refuse (see module-level comment above).
  const availableIsolationBackends: IsolationBackend[] = [];

  return {
    platform: "win32",
    availableIsolationBackends,
    // Without a Job Object we cannot guarantee a stop reaches the full
    // descendant tree, nor can we verify tree membership at all — the only
    // honest answer is "unverified" (types.ts: "ownership could not be
    // established; refuse unless explicitly accepted").
    strongestOwnershipScope: "unverified",
    // Requires native helper cooperation with the target process to deliver
    // a configured shutdown message; unavailable here (see LIMITATIONS).
    supportsGracefulApplicationShutdown: false,
    // Delegated cgroups are a Linux-only concept; always false on win32.
    supportsDelegatedCgroup: false,
    nativeHelperAvailable,
    limitations: [...LIMITATIONS],
  };
}

// ---------------------------------------------------------------------------
// Path canonicalization
// ---------------------------------------------------------------------------

/**
 * Resolve symlinks/junctions and verify existence via Node's native
 * `fs.realpath`, which on Windows already understands drive letters, UNC
 * paths (`\\server\share\...`) and NTFS reparse points (junctions/symlinks)
 * without any extra platform-specific code here.
 *
 * Deliberately NOT attempted here: "fixing" case. NTFS is case-insensitive
 * but case-preserving — two paths that differ only in case may refer to the
 * same file, but this adapter does not normalize case, matching solution.md
 * §5's framing of case-insensitivity as something to "acknowledge", not
 * silently rewrite (rewriting could mask a caller's own typo/assumption
 * bugs under a false sense of exact-match correctness).
 */
async function canonicalizePath(path: string): Promise<string> {
  return realpath(path);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * File-based mutual exclusion via O_CREAT|O_EXCL exclusive create. This is
 * portable: Node's `fs.open` flags map onto the underlying Win32
 * CreateFile call with CREATE_NEW semantics on NTFS, so the same
 * create-or-fail atomicity holds on Windows as on POSIX.
 *
 * This is explicitly file-based mutual exclusion, not a native Windows
 * named mutex/semaphore object — it is a stable lock *file* (never
 * deleted/replaced while held, per solution.md §7) whose presence is the
 * signal, matching the POSIX adapters' lock semantics so storage code (T05)
 * can treat all platforms uniformly through this one `acquireLock` contract.
 *
 * Windows sharing-violation retries (e.g. antivirus/indexer holding a
 * transient handle) are explicitly NOT handled here — solution.md §7
 * assigns "Handle Windows sharing violations with bounded retries" to the
 * storage/publication layer (T05), not to this lock primitive. This
 * function either atomically creates the lock or fails; retry policy around
 * transient Windows-specific failures belongs one layer up.
 */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  await fs.mkdir(dirname(path), { recursive: true });
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      throw new BackgroundJobError("lock-held", `Lock already held: ${path}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  } finally {
    await handle.close();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fs.unlink(path).catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

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

  // Let the parent CLI process exit without waiting on this child.
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    throw new BackgroundJobError(
      "storage-unavailable",
      `Failed to launch detached supervisor: no pid assigned (${spawnError?.message ?? "unknown spawn failure"}).`,
    );
  }

  // Short fail-fast window, same rationale as the POSIX adapters: catches
  // immediate exec/crash failures; not a liveness guarantee by itself.
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

  // KNOWN-WEAKER GUARANTEE, specific to this Node-only Windows path: with no
  // native helper there is no Job Object to assign this process into, so we
  // cannot report `ownershipScope: "job-object"` — doing so would falsely
  // claim tree ownership this adapter does not hold (solution.md §5/§12:
  // "No POSIX-signal or PID-walk fallback masquerades as tree ownership.").
  // We report "unverified" instead, and `ownershipHandle` is nothing more
  // than the bare pid, best-effort only.
  const ownershipHandle = String(pid);

  // Node does not expose Windows process creation time (GetProcessTimes)
  // without a native addon. We cannot honestly populate `creationIdentity`,
  // so we mark it explicitly "unavailable" rather than leaving it blank or
  // guessing — callers (recovery/T12) must treat PID-reuse protection on
  // this path as weaker than the POSIX adapters' /proc-start-time check.
  const identity: ProcessIdentity = { pid, creationIdentity: "unavailable" };

  return {
    identity,
    ownershipHandle,
    ownershipScope: "unverified",
  };
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * Existence-only liveness check via `process.kill(pid, 0)`, which Node
 * documents as cross-platform: on Windows it uses an existence test rather
 * than actually delivering a signal (there is no POSIX signal-0 semantic on
 * Windows, but Node's implementation still reports "does this pid exist").
 *
 * Because `identity.creationIdentity` is always "unavailable" on this
 * adapter (see launchDetachedSupervisor), this check is existence-only and
 * is therefore vulnerable to PID reuse: if the original supervisor pid has
 * exited and the OS has recycled that pid for an unrelated process, this
 * will incorrectly report "alive". This is a clearly flagged limitation
 * (see detectCapabilities().limitations), not silently treated as
 * equivalent to the POSIX adapters' creation-time-verified check.
 */
async function verifyAlive(identity: ProcessIdentity): Promise<boolean> {
  try {
    process.kill(identity.pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // EPERM means the pid exists but we lack permission to signal it — still
    // evidence of existence (mirrors the POSIX adapters' handling).
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

// ---------------------------------------------------------------------------
// Stop / force-stop
// ---------------------------------------------------------------------------

/**
 * No Job Object tree ownership exists on this path (see module-level
 * comment and detectCapabilities().limitations). This limitation string is
 * attached to every StopOutcome produced here so callers never mistake a
 * single-process kill for tree ownership.
 */
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
  // This adapter never produces a "job-object" ownershipHandle (see
  // launchDetachedSupervisor), so it only ever expects to be asked to stop
  // "unverified" scopes it created itself. A caller asking this adapter to
  // stop a "job-object" scope would imply a native helper this build does
  // not have; refuse rather than guess at Job Object semantics we can't
  // perform.
  if (ownershipScope !== "unverified") {
    throw new BackgroundJobError(
      "unsupported-platform",
      `Windows adapter (no native helper in this delivery) only supports ownershipScope "unverified"; got "${ownershipScope}". ` +
        `Job Object tree ownership is not implemented — see detectCapabilities().limitations.`,
    );
  }
}

/**
 * Windows has no portable SIGTERM-equivalent that Node can deliver to an
 * arbitrary process without that process explicitly handling a custom
 * console-control-event (which Node also does not expose portably).
 * `process.kill(pid)` on Windows always force-terminates immediately via
 * TerminateProcess — there is no separate graceful/forceful distinction
 * available at this layer. Both stopOwnedScope and forceStopOwnedScope
 * therefore do the same single-pid termination; the only difference is
 * stopOwnedScope polls up to `graceMs` for the (already-forceful)
 * termination to be observed, matching the PlatformAdapter contract's
 * shape even though there is no real "graceful request" step to perform.
 */
async function stopOwnedScope(
  ownershipHandle: string,
  ownershipScope: ProcessOwnershipScope,
  graceMs: number,
): Promise<StopOutcome> {
  assertSupportedScope(ownershipScope);
  const pid = parsePid(ownershipHandle);

  try {
    // On Windows, Node's process.kill(pid) with no signal (or any signal
    // argument) maps to TerminateProcess — there is no softer delivery.
    process.kill(pid);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") throw error; // ESRCH: already gone, fine.
  }

  const observedStopped = await waitForPidGone(pid, graceMs);

  return {
    observedStopped,
    // Nothing "escalates" beyond TerminateProcess on this path; Node issued
    // the only forceful primitive it has immediately.
    escalated: false,
    // No tree accounting exists at all without a Job Object — always false,
    // explicitly, never inferred from the single-pid check succeeding.
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

  // process.kill on Windows is already forceful (TerminateProcess); poll
  // briefly to observe the outcome rather than asserting immediately.
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
