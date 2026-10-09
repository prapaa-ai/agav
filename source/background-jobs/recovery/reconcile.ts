/**
 * T12 — Recovery and reconciliation.
 *
 * Implements solution.md §6 "A missed heartbeat means investigate. Quiet
 * logs, system sleep and permission-denied probes do not establish death."
 * and the follow-on bullet list for what to do after a crash. This module
 * returns DECISIONS to its caller (per README.md: "recovery.ts ... returns
 * decisions, does not orchestrate" and T12's acceptance: "Return decisions
 * to the coordinator rather than importing its orchestration"). It never
 * constructs or imports a coordinator — none exists yet; T14 will call
 * `reconcileJob` directly.
 *
 * Evidence-gathering order for a `running` job, matching solution.md §6's
 * "reconnect to an identifiable supervisor" before falling back to anything
 * weaker:
 *   1. IPC reconnect + `{type:'poll'}`, nonce-checked against the stored
 *      record. A matching nonce is strong, specific evidence that the
 *      responding process *is* the same job instance (not merely some
 *      unrelated process that happens to be listening on a reused/stale
 *      socket path) — see pid-reuse-guard.ts for the analogous PID-level
 *      concern this nonce check solves at the IPC layer.
 *   2. If IPC is unreachable (connection refused / socket missing /
 *      timeout), that is NOT proof of death by itself. Fall back to
 *      `isSameLiveProcess` (OS-level liveness, PID-reuse-safe) against the
 *      stored `ProcessIdentity`.
 *   3. Supervisor absence is not an owned-workload terminal observation.
 *      Preserve uncertainty, admission capacity and cleanup protection;
 *      never assume descendants died or signal any historical PID.
 *
 * Every lifecycle-changing write happens only after acquiring the job's
 * lock (`withJobLock`) and re-reading the record to defend against a
 * concurrent writer (the live supervisor, or another reconciliation pass)
 * — "recovery may take lifecycle ownership only after acquiring its lock
 * and reconciling live evidence" (solution.md §7) and "a single lifecycle
 * writer per job" must never be fought over. Writes go through the normal
 * `Repositories.jobs.update()` path; `withJobLock` is reentrant within one
 * async call stack (see storage/single-writer-lock.ts), so `update()`'s own
 * internal lock acquisition safely re-enters rather than deadlocking.
 */
import { BackgroundJobError, isTerminalLifecycle, isUncertainLifecycle, type JobRecord, type Repositories } from "../types.js";
import { getPlatformAdapter } from "../platform/index.js";
import { withJobLock } from "../storage/single-writer-lock.js";
import { IpcClient } from "../ipc/client.js";
import { isSameLiveProcess } from "./pid-reuse-guard.js";

const LOCK_RETRY_ATTEMPTS = 5;
const LOCK_RETRY_DELAY_MS = 30;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` under the job's lock, tolerating brief, EXPECTED contention from
 * the job's own live supervisor (a different OS process) writing its own
 * terminal-state update at roughly the same moment reconciliation wants to
 * write. `PlatformAdapter.acquireLock` deliberately never retries/steals on
 * `lock-held` (solution.md §7: "a hung writer is unavailable until it exits
 * or is explicitly recovered") — that policy is correct for a genuinely
 * STUCK lock, but reconciliation's write path only ever contends with a
 * live writer for a few milliseconds, so a short bounded retry here is
 * reconciliation's own decision about transient contention, not an attempt
 * to steal a stale lock. If the lock is still held after all retries, the
 * `lock-held` error propagates — that is a genuine "investigate" signal,
 * not swallowed.
 */
async function withJobLockRetrying<T>(root: string, jobId: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await withJobLock(root, jobId, fn);
    } catch (error) {
      if (!(error instanceof BackgroundJobError) || error.code !== "lock-held") throw error;
      lastError = error;
      if (attempt < LOCK_RETRY_ATTEMPTS - 1) await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/**
 * Publish a patch to the job record while recovery already holds the job
 * lock. `storage/single-writer-lock.ts`'s `withJobLock` is reentrant within
 * one async call stack (integration-owner fix, see its module doc), so this
 * can safely call through the normal `Repositories.jobs.update()` path
 * instead of writing around the repository — `update()`'s own internal
 * `withJobLock` call becomes a no-op re-entry rather than deadlocking.
 */
async function publishWhileLocked(
  repositories: Repositories,
  jobId: string,
  patch: Partial<JobRecord>,
): Promise<JobRecord> {
  await repositories.jobs.update(jobId, patch);
  const updated = await repositories.jobs.get(jobId);
  if (updated === undefined) {
    throw new Error(`reconcileJob: JobRecord for jobId "${jobId}" disappeared immediately after update.`);
  }
  return updated;
}

export type ReconcileAction =
  | "none"
  | "reconnected"
  | "marked-interrupted"
  | "marked-unknown"
  | "marked-recovery-required";

export interface ReconcileResult {
  action: ReconcileAction;
  record: JobRecord;
}

export interface ReconcileJobArgs {
  jobId: string;
  repositories: Repositories;
  root: string;
  socketPathFor: (jobId: string) => string;
  /** Overridable clock for deterministic tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

/** IPC poll response shape, matching supervisor/lifecycle.ts's `PollResponse`. */
interface PollResponse {
  type: "poll";
  job: JobRecord | undefined;
}

function isPollResponse(msg: unknown): msg is PollResponse {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "poll";
}

/**
 * Attempt to reconnect to the job's supervisor over IPC and confirm (via
 * nonce match) that it is still the SAME job instance. Returns the freshly
 * polled record on success, or `undefined` if unreachable or the nonce did
 * not match (treated identically to "unreachable" by the caller — a
 * mismatched nonce means whatever answered is not evidence this job is
 * alive).
 *
 * Empty `expectedNonce` special case: the coordinator persists a job's
 * initial record with `nonce: ""` as a placeholder BEFORE the supervisor
 * has started (see coordinator/service.ts's `start()` and T11's own
 * `JobSupervisor.start()`, which is what actually establishes the real
 * handshake nonce once it runs). A reconciliation pass can legitimately run
 * during that brief window — e.g. the very first `poll()` right after
 * `start()` returns. If we required an exact nonce match here, a
 * perfectly-healthy, freshly-started supervisor answering correctly on its
 * own freshly-created socket path (which cannot be stale/reused — the
 * coordinator just minted this exact socket path for this exact jobId with
 * a fresh randomUUID) would still be treated as "not reconnected" purely
 * because our local copy of the nonce hadn't been refreshed yet, forcing
 * every such poll through the slower, lock-acquiring uncertain-state path
 * for no reason and creating unnecessary contention with the supervisor's
 * own rapid startup writes. So: an empty `expectedNonce` accepts ANY
 * syntactically valid poll response as reconnection evidence (nonce
 * matching only guards against a stale socket path answering for a
 * *different*, unrelated job instance — a concern that doesn't apply before
 * we have ever observed a real nonce to compare against).
 */
async function tryReconnect(socketPath: string, expectedNonce: string): Promise<JobRecord | undefined> {
  let client: IpcClient | undefined;
  try {
    client = await IpcClient.connectWithRetry(socketPath, { retries: 2, delayMs: 100, timeoutMs: 2000 });
    const reply = await client.request({ type: "poll" }, 2000);
    if (!isPollResponse(reply) || reply.job === undefined) {
      return undefined;
    }
    if (expectedNonce !== "" && reply.job.nonce !== expectedNonce) {
      // Stale/reused socket path answered by an unrelated process/job
      // instance: NOT evidence this job is alive.
      return undefined;
    }
    return reply.job;
  } catch {
    // Connection refused, socket missing, timeout, handshake failure, etc.
    // None of these alone establish death (solution.md §6) — the caller
    // falls through to the OS-level liveness check.
    return undefined;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/**
 * Re-check live evidence for a job that is `running`, `unknown` or
 * `recovery-required` (i.e. not yet terminal). Returns:
 *   - `{ kind: 'reconnected', job }` if the supervisor answered with a
 *     matching nonce.
 *   - `{ kind: 'process-alive' }` if IPC was unreachable but the OS process
 *     is confirmed still alive (ambiguous: no working control channel, but
 *     not dead either).
 *   - `{ kind: 'process-gone' }` if IPC was unreachable and the OS process
 *     is confirmed not alive. Missing/weak identity is inconclusive.
 */
async function gatherLiveEvidence(
  record: JobRecord,
  socketPath: string,
): Promise<{ kind: "reconnected"; job: JobRecord } | { kind: "process-alive" } | { kind: "process-gone" } | { kind: "inconclusive" }> {
  const reconnected = await tryReconnect(socketPath, record.nonce);
  if (reconnected) {
    return { kind: "reconnected", job: reconnected };
  }

  // identity is the workload, not the detached supervisor. A weak/missing
  // creation identity cannot establish absence of the original supervisor.
  const identity = record.supervisorIdentity;
  if (!identity || !identity.creationIdentity || identity.creationIdentity === "unavailable" || identity.creationIdentity === String(identity.pid)) {
    return { kind: "inconclusive" };
  }
  const adapter = await getPlatformAdapter();
  try {
    const alive = await isSameLiveProcess(identity, adapter);
    return { kind: alive ? "process-alive" : "process-gone" };
  } catch {
    // Permission/OS probe errors do not establish death.
    return { kind: "inconclusive" };
  }
}

/**
 * Reconcile the on-disk state of a single job against live evidence. See
 * module doc for the evidence-gathering order and the full task brief in
 * subtasks.md T12 for the per-state decision table.
 */
export async function reconcileJob(args: ReconcileJobArgs): Promise<ReconcileResult> {
  const { jobId, repositories, socketPathFor } = args;

  const initial = await repositories.jobs.get(jobId);
  if (initial === undefined) {
    throw new Error(`reconcileJob: no JobRecord found for jobId "${jobId}".`);
  }

  // (a) Terminal results are already verified and must never be re-touched.
  if (isTerminalLifecycle(initial.state)) {
    return { action: "none", record: initial };
  }

  // (b) Handshake not yet confirmed running: ambiguous execution, per
  // solution.md §6 "If command creation may have happened but execution is
  // ambiguous, report recovery-required; do not launch a replacement
  // automatically." We still give it a chance to resolve via live evidence
  // first (e.g. the supervisor already advanced past "starting" concurrently
  // with this reconciliation pass).
  //
  // Evidence-gathering (IPC round-trip + OS liveness probe) is deliberately
  // done BEFORE acquiring the job lock: it is read-only and can take up to a
  // couple of seconds with retries, whereas the live supervisor (a separate
  // OS process) may need that same lock at any moment to publish its own
  // terminal-state update. Holding the lock for the whole evidence-gathering
  // window would turn an expected, brief write/write race into an
  // unnecessarily wide one. Only the final, short read-then-write is done
  // under the lock.
  if (initial.state === "accepted" || initial.state === "starting") {
    const socketPath = socketPathFor(jobId);
    const evidence = await gatherLiveEvidence(initial, socketPath);
    if (evidence.kind === "reconnected") {
      return { action: "reconnected", record: evidence.job };
    }

    return withJobLockRetrying(args.root, jobId, async () => {
      const fresh = await repositories.jobs.get(jobId);
      if (fresh === undefined) {
        throw new Error(`reconcileJob: JobRecord for jobId "${jobId}" disappeared during reconciliation.`);
      }
      // Re-check: another writer may have moved this job on since we loaded
      // `initial`. Re-run the state-appropriate branch against fresh data
      // rather than blindly overwriting. If it moved to "running", the job
      // is no longer ambiguous — leave it for a future reconcile pass to
      // evaluate with fresh evidence rather than running a slow IPC/OS
      // liveness probe while still holding this lock (evidence-gathering
      // must happen outside the lock; see the module-level rationale).
      if (isTerminalLifecycle(fresh.state)) {
        return { action: "none", record: fresh };
      }
      if (fresh.state === "running") {
        return { action: "none", record: fresh };
      }
      if (fresh.state !== "accepted" && fresh.state !== "starting") {
        // Already unknown/recovery-required: idempotent no-op from this
        // branch's perspective (step d handles those states normally, but
        // since we're already holding the lock and have fresh data, just
        // report no-op here; a subsequent explicit reconcile pass will
        // re-run evidence gathering for it).
        return { action: "none", record: fresh };
      }

      const updated = await publishWhileLocked(repositories, jobId, {
        state: "recovery-required",
        uncertaintyReason:
          "supervisor handshake never confirmed before reconciliation; command creation may have happened but execution is ambiguous",
      });
      return { action: "marked-recovery-required", record: updated };
    });
  }

  // (c) Running: establish live evidence BEFORE acquiring the lock (see
  // rationale above), then apply the appropriate transition under a short
  // locked read-then-write.
  if (initial.state === "running") {
    return reconcileRunningUnlocked(args, initial);
  }

  // (d) Already uncertain: give it a chance to resolve, otherwise idempotent
  // no-op.
  if (isUncertainLifecycle(initial.state)) {
    const socketPath = socketPathFor(jobId);
    const evidence = await gatherLiveEvidence(initial, socketPath);
    if (evidence.kind === "reconnected") {
      return { action: "reconnected", record: evidence.job };
    }
    // Still inconclusive: leave as-is, no flapping.
    return { action: "none", record: initial };
  }

  // Exhaustive per LifecycleState; should be unreachable.
  return { action: "none", record: initial };
}

/**
 * Gather live evidence for a `running` record WITHOUT holding the job lock
 * (read-only, can take up to a couple of seconds with IPC retries — see the
 * rationale in `reconcileJob`'s (c) branch), then apply the appropriate
 * transition under a short, freshly-re-read, locked read-then-write. Used
 * directly for a job found already `running`, and from within the
 * accepted/starting branch's own lock when a fresh re-read reveals the
 * supervisor has since reached `running` (that case gathers fresh evidence
 * while still holding the lock from its own read-then-write, which is safe
 * because by then the race window is just the final write, not the whole
 * evidence-gathering probe).
 */
async function reconcileRunningUnlocked(args: ReconcileJobArgs, record: JobRecord): Promise<ReconcileResult> {
  const { jobId, repositories, socketPathFor } = args;
  const socketPath = socketPathFor(jobId);
  const evidence = await gatherLiveEvidence(record, socketPath);

  if (evidence.kind === "reconnected") {
    // The live supervisor remains the single lifecycle writer; we only
    // confirmed it is still in charge. Do not write anything ourselves.
    return { action: "reconnected", record: evidence.job };
  }

  const nextState = "unknown";
  const uncertaintyReason =
    evidence.kind === "process-alive"
      ? "supervisor process alive but IPC unreachable; workload outcome is unverified"
      : evidence.kind === "process-gone"
        ? "supervisor process confirmed gone; workload descendants may remain and were not cleaned up; no owned-scope terminal observation"
        : "supervisor identity missing or inconclusive and IPC unreachable; workload descendants may remain; no owned-scope terminal observation";

  return withJobLockRetrying(args.root, jobId, async () => {
    const fresh = await repositories.jobs.get(jobId);
    if (fresh === undefined) {
      throw new Error(`reconcileJob: JobRecord for jobId "${jobId}" disappeared during reconciliation.`);
    }
    // Re-check under the lock: another writer (the live supervisor, most
    // likely) may have already published a terminal result, or even a fresh
    // "running" state via a new handshake, while we were gathering
    // evidence. Never clobber a state that has already moved on.
    if (isTerminalLifecycle(fresh.state)) {
      return { action: "none", record: fresh };
    }
    if (fresh.state !== "running") {
      return { action: "none", record: fresh };
    }
    const updated = await publishWhileLocked(repositories, jobId, { state: nextState, uncertaintyReason });
    return {
      action: "marked-unknown",
      record: updated,
    };
  });
}


