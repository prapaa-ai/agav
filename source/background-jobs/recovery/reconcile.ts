/**
 * Returns reconciliation decisions; never orchestrates. Evidence order for a live-looking job:
 * IPC poll (nonce-checked), then OS liveness of the supervisor. Quiet logs, sleep and
 * permission-denied probes never establish death, and supervisor absence is not a terminal
 * observation of the workload: descendants may remain, so nothing is signalled or assumed dead.
 *
 * Lifecycle writes happen only under the job lock after re-reading the record. `withJobLock` is
 * reentrant within one call stack, so `jobs.update()` re-enters instead of deadlocking.
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
 * Short bounded retry for transient contention with the job's live supervisor writing its own
 * terminal state. Never steals a lock; if still held after the retries, `lock-held` propagates.
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
  now?: () => Date;
}

interface PollResponse {
  type: "poll";
  job: JobRecord | undefined;
}

function isPollResponse(msg: unknown): msg is PollResponse {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "poll";
}

/**
 * Polls the supervisor and returns its record, or `undefined` if unreachable or the nonce differs
 * (a different job instance answering on a stale socket is not evidence of life).
 *
 * An empty `expectedNonce` accepts any valid poll response: the coordinator persists `nonce: ""`
 * until the supervisor's handshake sets the real one, and the freshly minted socket path cannot be stale.
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
      return undefined;
    }
    return reply.job;
  } catch {
    // Unreachable alone does not establish death; the caller falls back to the OS liveness check.
    return undefined;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function gatherLiveEvidence(
  record: JobRecord,
  socketPath: string,
): Promise<{ kind: "reconnected"; job: JobRecord } | { kind: "process-alive" } | { kind: "process-gone" } | { kind: "inconclusive" }> {
  const reconnected = await tryReconnect(socketPath, record.nonce);
  if (reconnected) {
    return { kind: "reconnected", job: reconnected };
  }

  // `identity` is the workload, not the detached supervisor. A weak/missing
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

export async function reconcileJob(args: ReconcileJobArgs): Promise<ReconcileResult> {
  const { jobId, repositories, socketPathFor } = args;

  const initial = await repositories.jobs.get(jobId);
  if (initial === undefined) {
    throw new Error(`reconcileJob: no JobRecord found for jobId "${jobId}".`);
  }

  // (a) Terminal results are already verified and must never be re-touched.
  if (initial.abandonment || isTerminalLifecycle(initial.state)) {
    return { action: "none", record: initial };
  }

  // (b) Handshake not yet confirmed: execution is ambiguous, so report recovery-required and never
  // launch a replacement. Evidence gathering (up to a couple of seconds) deliberately happens
  // BEFORE taking the job lock so the live supervisor's own write is not blocked; only the final
  // read-then-write is locked.
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
      // Another writer may have moved the job on since `initial`. If it is now "running", leave it
      // for a later pass rather than probing IPC/OS while holding the lock.
      if (isTerminalLifecycle(fresh.state)) {
        return { action: "none", record: fresh };
      }
      if (fresh.state === "running") {
        return { action: "none", record: fresh };
      }
      if (fresh.state !== "accepted" && fresh.state !== "starting") {
        // Already unknown/recovery-required: no-op; a later pass re-gathers evidence.
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

  // (c) Running.
  if (initial.state === "running") {
    return reconcileRunningUnlocked(args, initial);
  }

  // (d) Already uncertain: it may resolve via reconnect, otherwise no-op.
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

/** Gathers evidence without the job lock, then applies the transition in a short locked re-read-and-write. */
async function reconcileRunningUnlocked(args: ReconcileJobArgs, record: JobRecord): Promise<ReconcileResult> {
  const { jobId, repositories, socketPathFor } = args;
  const socketPath = socketPathFor(jobId);
  const evidence = await gatherLiveEvidence(record, socketPath);

  if (evidence.kind === "reconnected") {
    // The live supervisor stays the single lifecycle writer.
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
    // The live supervisor may have published a newer state while we gathered evidence; never clobber it.
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
