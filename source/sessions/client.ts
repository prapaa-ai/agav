import { randomUUID } from "node:crypto";
import type { ConfirmResult, SteerDrainOptions } from "../agent/loop.js";
import { isTerminalLifecycle, type CoordinatorClient, type JobSummary, type SessionPolicySnapshot } from "../background-jobs/types.js";
import { decideSessionApproval, listPendingApprovals, type PendingSessionApproval } from "./approvals.js";
import { sessionWorkerRequestId } from "./launch.js";
import { SessionRuntimeStore, type SessionRuntimeRecord } from "./store.js";

export interface SessionSnapshot {
  record: SessionRuntimeRecord;
  approvals: PendingSessionApproval[];
}

async function coordinator(): Promise<Pick<CoordinatorClient, "poll" | "stop">> {
  // Attaching must not load the background-job runtime until it is actually needed.
  return (await import("../background-jobs-integration.js")).getSharedCoordinator();
}
function active(record: SessionRuntimeRecord): boolean {
  return ["starting", "running", "needs-approval"].includes(record.status);
}
async function requireRecord(id: string, store: SessionRuntimeStore): Promise<SessionRuntimeRecord> {
  const record = await store.read(id);
  if (!record) throw new Error(`Session runtime not found: ${id}`);
  return record;
}

/**
 * The supervisor's last recorded state for a job, read without reconciling it: no supervisor IPC
 * (whose reconnect retries alone cost ~200ms when a worker is gone) and no OS process probe.
 */
async function recordedJob(jobId: string): Promise<JobSummary | undefined> {
  const { getSharedCoordinator } = await import("../background-jobs-integration.js");
  const record = await (await getSharedCoordinator()).repositories.jobs.get(jobId);
  return record && { jobId: record.jobId, requestId: record.requestId, state: record.state, stopState: record.stopState };
}

/** Supervisor evidence for an active worker. Missing or uncertain evidence is not termination. */
async function observeWorker(observed: SessionRuntimeRecord,
  evidence: (jobId: string) => Promise<JobSummary | undefined> = async jobId => (await coordinator()).poll(jobId)): Promise<JobSummary | undefined> {
  if (!active(observed) || !observed.jobId) return undefined;
  let job: JobSummary | undefined;
  try { job = await evidence(observed.jobId); }
  catch { /* Offline coordinators and absent jobs cannot prove that a worker stopped. */ }
  if (job && (job.jobId !== observed.jobId || job.requestId !== sessionWorkerRequestId(observed))) {
    throw new Error("Session worker identity mismatch.");
  }
  return job;
}

/** Caller holds the session lock. Records a confirmed-ended worker, then reads its consent. */
async function settleSnapshot(id: string, store: SessionRuntimeStore, observed: SessionRuntimeRecord,
  job: JobSummary | undefined): Promise<SessionSnapshot> {
  let record = await requireRecord(id, store);
  // The worker can finish or ownership can change while the coordinator is responding.
  if (job && isTerminalLifecycle(job.state) && record.generation === observed.generation &&
      record.jobId === observed.jobId && active(record)) {
    record = await store.update(id, observed.generation, latest => {
      latest.status = "interrupted";
      latest.error = `Session worker ended (${job.state}) before recording completion.`;
    });
  }
  return { record, approvals: await listPendingApprovals(store, id) };
}

/** Observe an existing execution only. Missing or uncertain supervisor evidence is not termination. */
export async function readSessionSnapshot(id: string, store = new SessionRuntimeStore()): Promise<SessionSnapshot> {
  const observed = await requireRecord(id, store);
  const job = await observeWorker(observed);
  return store.lock(id, () => settleSnapshot(id, store, observed, job));
}

/**
 * Listing snapshot for the resume picker. Same outcome as {@link readSessionSnapshot} for a worker
 * the supervisor has recorded as ended: the session is recorded as interrupted and its stale consent
 * hidden. Without its fixed per-session costs:
 *
 * - Evidence is the supervisor's recorded job state, never a live poll (no IPC, no process probe).
 *   A worker whose end is not recorded yet keeps its observed status, as with an offline
 *   coordinator; the selected session is still fully reconciled at load time.
 * - The lock is taken only when there is something to write. Runtime writes are atomic, so every
 *   other session is read lock-free, and a recorded end persists, so it is never paid twice.
 */
export async function readSessionListingSnapshot(id: string, store = new SessionRuntimeStore()): Promise<SessionSnapshot> {
  const observed = await requireRecord(id, store);
  const job = await observeWorker(observed, recordedJob);
  if (job && isTerminalLifecycle(job.state)) return store.lock(id, () => settleSnapshot(id, store, observed, job));
  return { record: observed, approvals: await listPendingApprovals(store, id) };
}

/** Presentation-only polling: disconnecting never cancels execution or answers consent. */
export function subscribeSession(id: string, callbacks: {
  onSnapshot(snapshot: SessionSnapshot): void;
  onError(error: Error): void;
}, options: { store?: SessionRuntimeStore; intervalMs?: number } = {}): () => void {
  const store = options.store ?? new SessionRuntimeStore();
  const intervalMs = Math.max(1, options.intervalMs ?? 250);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    try {
      const snapshot = await readSessionSnapshot(id, store);
      if (!disposed) callbacks.onSnapshot(snapshot);
    } catch (error) {
      if (!disposed) callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Schedule only after the previous read/callback settles, never overlapping polls.
      if (!disposed) timer = setTimeout(() => { void poll(); }, intervalMs);
    }
  };
  void poll();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export async function answerSessionApproval(id: string, approval: PendingSessionApproval, choice: ConfirmResult,
  store = new SessionRuntimeStore()): ReturnType<typeof decideSessionApproval> {
  if (approval.sessionId !== id) throw new Error("Session approval identity mismatch.");
  return decideSessionApproval(store, id, approval.approvalId, choice,
    { generation: approval.generation, inputHash: approval.inputHash });
}

/** Explicit user action; authorization (including its abort signal) belongs to the caller. */
export async function stopSessionExecution(id: string, policy: SessionPolicySnapshot, store = new SessionRuntimeStore()): Promise<void> {
  if (!policy) throw new Error("Stopping a session requires a caller policy snapshot.");
  const record = await requireRecord(id, store);
  if (!record.jobId) throw new Error(`Session ${id} has no supervisor worker job to stop.`);
  await (await coordinator()).stop(record.jobId, policy);
}

/** Cancel only the explicitly selected generation; no PID fallback or foreign-job grant. */
export async function requestSessionCancellation(id: string, generation: string, store = new SessionRuntimeStore()): Promise<void> {
  await store.update(id, generation, record => {
    if (["starting", "running", "needs-approval"].includes(record.status)) record.cancelRequested = true;
  });
}

export async function requestSessionSubagentCancellation(id: string, generation: string, subagentId: string, store = new SessionRuntimeStore()): Promise<void> {
  await store.update(id, generation, record => {
    if (["starting", "running", "needs-approval"].includes(record.status)) {
      record.cancelledSubagents = [...new Set([...(record.cancelledSubagents ?? []), subagentId])];
    }
  });
}

/** Durable acceptance only: the owning worker consumes at its next exact safe point. */
export async function requestSessionSteer(id: string, generation: string, directive: string, subagentId?: string,
  store = new SessionRuntimeStore()): Promise<void> {
  if (typeof directive !== "string" || !directive.trim()) throw new Error("Steering directive must not be empty.");
  if (subagentId !== undefined && (!subagentId || subagentId === "main")) throw new Error("Invalid child steering target.");
  if (subagentId?.startsWith("skill-")) throw new Error("Steering is not supported for skill executions.");
  const target = subagentId ?? "main";
  await store.update(id, generation, record => {
    if (!active(record) || record.cancelRequested) throw new Error("Session is inactive; cannot steer.");
    if (record.closedSteerTargets?.includes(target)) throw new Error("Steering recipient has completed; admission is closed.");
    if (subagentId !== undefined && (record.cancelledSubagents?.includes(subagentId) ||
        !record.subagentStates?.some(child => child.id === subagentId && child.status === "running"))) {
      throw new Error("Child steering recipient is missing, cancelled or inactive.");
    }
    (record.steers ??= []).push({ id: randomUUID(), target, directive: directive.trim(), status: "pending" });
  });
}

/** Atomically consume one recipient, closing final admission only when no continuation remains. */
export async function drainSessionSteers(id: string, generation: string, subagentId?: string, options: SteerDrainOptions = {},
  store = new SessionRuntimeStore()): Promise<string[]> {
  const directives: string[] = [];
  const target = subagentId ?? "main";
  await store.update(id, generation, record => {
    const available = active(record) && !record.cancelRequested && !record.closedSteerTargets?.includes(target) &&
      !record.cancelledSubagents?.includes(target) &&
      (subagentId === undefined || record.subagentStates?.some(child => child.id === subagentId && child.status === "running"));
    const canConsume = available && options.canContinue !== false;
    for (const steer of record.steers ?? []) {
      if (steer.target !== target || steer.status !== "pending") continue;
      steer.status = canConsume ? "consumed" : "rejected";
      if (canConsume) directives.push(steer.directive);
      else steer.error = available && options.canContinue === false
        ? "Steering recipient iteration budget is exhausted."
        : "Steering recipient is no longer active.";
    }
    if (options.final && (options.canContinue === false || (!directives.length && !options.hasLocalSteers))) {
      record.closedSteerTargets = [...new Set([...(record.closedSteerTargets ?? []), target])];
    }
  });
  return directives;
}
