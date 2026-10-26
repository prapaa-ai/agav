import type { ConfirmResult } from "../agent/loop.js";
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

/** Observe an existing execution only. Missing or uncertain supervisor evidence is not termination. */
export async function readSessionSnapshot(id: string, store = new SessionRuntimeStore()): Promise<SessionSnapshot> {
  const observed = await requireRecord(id, store);
  let job: JobSummary | undefined;
  if (active(observed) && observed.jobId) {
    try { job = await (await coordinator()).poll(observed.jobId); }
    catch { /* Offline coordinators and absent jobs cannot prove that a worker stopped. */ }
    if (job && (job.jobId !== observed.jobId || job.requestId !== sessionWorkerRequestId(observed))) {
      throw new Error("Session worker identity mismatch.");
    }
  }
  return store.lock(id, async () => {
    let record = await requireRecord(id, store);
    // The worker can finish or ownership can change while the coordinator is responding.
    if (job && isTerminalLifecycle(job.state) && record.generation === observed.generation &&
        record.jobId === observed.jobId && active(record)) {
      record = await store.update(id, observed.generation, latest => {
        latest.status = "interrupted";
        latest.error = `Session worker ended (${job!.state}) before recording completion.`;
      });
    }
    return { record, approvals: await listPendingApprovals(store, id) };
  });
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
