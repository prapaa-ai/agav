import type { ToolRegistry } from "../tools/registry.js";
import { BackgroundJobError, isLiveLifecycle } from "../background-jobs/types.js";
import { jobRequestId, scopedCheckpoints, visitJobScope, WorkflowStore, type LoopNodeCheckpoint, type WorkflowRun } from "./store.js";
import { applyJobOutcome, JobCancellationIncompleteError, stopJobNodeOutcome, type JobNodeDeps } from "./job-node.js";
import { decide, defaultDecider, isDecisionId, listPendingDecisions, readDecision, type DecidedRecord, type DecisionKind, type PendingDecision } from "./decisions.js";
import { findRunnerJob, launchRun, LaunchEnvironmentError, type LaunchDeps, type LaunchResult } from "./launch.js";
import { postRunNotification } from "./notify.js";
import { retriesOnResume } from "./executors.js";

export interface DecideOptions {
  registry: ToolRegistry;
  /** `user@host` recorded on the decision (default: this process's user and host). */
  by?: string;
  note?: string;
  /** With launch deps, a won decision on a parked run relaunches its runner (attempt+1). */
  launch?: LaunchDeps;
  /** How long to wait for a parking runner to exit before relaunching (default 5000 ms). */
  parkWaitMs?: number;
}
export interface DecideResult {
  won: boolean;
  record: DecidedRecord;
  pending: PendingDecision;
  run: WorkflowRun;
  /** `live`: the runner is still executing and applies the decision in-process. */
  relaunch?: LaunchResult | ManualResumeRequired | "live";
}
/**
 * The decision is recorded but the run (e.g. `interrupted`, never revisited by automatic reconcile) was NOT launched
 * or queued: nothing will start it until someone resumes it from a context with the selected environment.
 * Discriminate on `manualResumeRequired`/`status`; `run` and `reason` mirror `LaunchResult` for existing consumers.
 */
export interface ManualResumeRequired { status: "manual-resume-required"; manualResumeRequired: true; run: WorkflowRun; reason: string }

const TERMINAL = ["passed", "failed", "cancelled", "timed_out"];

/** The run's pending decision for `target` (a decision id, or a node id with exactly one undecided decision). */
export async function resolveDecisionTarget(store: WorkflowStore, runId: string, target: string, kind?: DecisionKind): Promise<PendingDecision> {
  if (isDecisionId(target)) {
    const state = await readDecision(store, runId, target);
    if (!state || (kind && state.pending.kind !== kind)) throw new Error(`No ${kind ?? "workflow"} decision ${target} in run ${runId}.`);
    return state.pending;
  }
  const matches = (await listPendingDecisions(store, runId)).filter(item => item.nodeId === target && (!kind || item.kind === kind));
  if (matches.length === 0) throw new Error(`Node ${target} has no pending ${kind ?? ""}${kind ? " " : ""}decision in run ${runId}.`);
  if (matches.length > 1) throw new Error(`Node ${target} has several pending decisions (${matches.map(item => item.decisionId).join(", ")}); pass the decision id.`);
  return matches[0]!;
}

/**
 * Decides any inbox decision of a run. Only a create-once `.decided.json` is written (never run.json); the
 * runner applies it. The winner of a parked run relaunches the runner, waiting briefly for a parking runner
 * to exit; a runner still executing other branches picks the decision up from `decisions/` itself.
 */
export async function decideRunDecision(store: WorkflowStore, runId: string, decisionId: string, approve: boolean, opts: DecideOptions): Promise<DecideResult> {
  const before = await store.read(runId, opts.registry);
  if (TERMINAL.includes(before.status)) throw new Error(`Run ${runId} is ${before.status}; nothing to decide.`);
  const state = await readDecision(store, runId, decisionId);
  if (!state) throw new Error(`No decision ${decisionId} in run ${runId}.`);
  const { won, record } = await decide(store, runId, decisionId, approve, opts.by ?? defaultDecider(), opts.note);
  let run = await store.read(runId, opts.registry);
  const result: DecideResult = { won, record, pending: state.pending, run };
  if (!won || !opts.launch || !run.consent || !run.runner) return result;
  const deadline = Date.now() + (opts.parkWaitMs ?? 5000);
  for (;;) {
    const job = await findRunnerJob(opts.launch.coordinator, run);
    if (!job || !isLiveLifecycle(job.state)) break;
    // Live and not parked: the runner polls decisions/ and applies this one in-process.
    if (run.status !== "waiting_approval" || Date.now() >= deadline) return { ...result, relaunch: "live" };
    await new Promise(resolve => setTimeout(resolve, 100));
    run = await store.read(runId, opts.registry);
  }
  if (TERMINAL.includes(run.status)) return { ...result, run };
  // The decision is recorded above regardless: a context lacking the selected env defers the relaunch instead of failing the approval.
  let relaunch: LaunchResult | ManualResumeRequired;
  // LaunchEnvironmentError means launchRun left the run untouched and un-queued (state e.g. `interrupted`; only a stricter sandboxRequired is persisted first), so never report it as queued.
  try { relaunch = await launchRun(store, runId, { registry: opts.registry, ...opts.launch }); }
  catch (error) { if (!(error instanceof LaunchEnvironmentError)) throw error; relaunch = { status: "manual-resume-required", manualResumeRequired: true, run: await store.read(runId, opts.registry), reason: error.reason }; }
  return { ...result, run: relaunch.run, relaunch };
}

/** Decides an `approval` decision by node id or decision id (see `decideRunDecision`). */
export async function decideApproval(store: WorkflowStore, runId: string, target: string, approve: boolean, opts: DecideOptions): Promise<DecideResult> {
  const pending = await resolveDecisionTarget(store, runId, target, "approval");
  return decideRunDecision(store, runId, pending.decisionId, approve, opts);
}

/** One-line outcome for the CLI and slash command. */
export function decisionSummary(result: DecideResult): string {
  const { pending, record } = result;
  const verb = record.decision === "approve" ? "approved" : "denied";
  if (!result.won) return `Decision ${pending.decisionId} (${pending.kind} on ${pending.nodeId}) was already ${verb} by ${record.decidedBy} at ${record.decidedAt}.`;
  const follow = result.relaunch === undefined ? "" : result.relaunch === "live" ? "; the live runner applies it"
    : result.relaunch.status === "manual-resume-required" ? `; decision recorded but the run is ${result.relaunch.run.status} and was not launched or queued: ${result.relaunch.reason}; manual resume required: agav workflows resume ${result.run.id}`
    : `; runner ${result.relaunch.status} (attempt ${result.relaunch.run.runner?.attempt ?? 1})${result.relaunch.reason ? `: ${result.relaunch.reason}` : ""}`;
  return `${pending.kind} on ${pending.nodeId} ${verb} (${pending.decisionId}) in run ${result.run.id}${follow}.`;
}

/**
 * Asks the supervisor to SIGTERM a live runner so it checkpoints `cancelled` promptly. Best effort: the cancel
 * marker is already durable and a live runner polls it, so a denied or failed stop never blocks cancellation.
 */
async function stopRunner(requestId: string, jobDeps: JobNodeDeps): Promise<void> {
  try {
    const coordinator = await jobDeps.getCoordinator();
    const job = await coordinator.findByRequestId?.(requestId);
    if (!job || job.requestId !== requestId || !isLiveLifecycle(job.state)) return;
    const session = typeof jobDeps.session === "function" ? jobDeps.session() : jobDeps.session;
    await coordinator.stop(job.jobId, session);
  } catch { /* the cancel marker still stops the runner */ }
}

/**
 * Durable intent first; never claim cancellation until the executor releases its lock.
 * With `jobDeps`, a running job node is reconciled and stopped under the lock; the run is only
 * marked cancelled once every job node is terminal. Otherwise a `JobCancellationIncompleteError`
 * is thrown and the node/run stay non-terminal with their job linkage so cancel/resume can retry.
 */
export async function cancelRun(store: WorkflowStore, id: string, registry: ToolRegistry, signal?: AbortSignal, jobDeps?: JobNodeDeps): Promise<WorkflowRun> {
  const existing = await store.read(id, registry);
  if (["passed", "failed", "cancelled", "timed_out"].includes(existing.status)) return existing;
  await store.requestCancel(id);
  if (existing.runner && jobDeps) await stopRunner(existing.runner.requestId, jobDeps);
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await store.lock(id, async () => {
        const run = await store.read(id, registry);
        // Leaf checkpoints at every depth, including the body nodes of loop iterations (loop nodes are containers).
        const visits = scopedCheckpoints(run);
        for (const visit of visits) {
          const cp = visit.cp;
          if (cp.status !== "running" || visit.node.type === "loop") continue;
          const definitionNode = visit.node;
          const isJob = definitionNode?.type === "job";
          // A retry-safe agent/prompt node ran inside the (now dead: we hold the lock) runner process, so it has stopped.
          if (definitionNode && retriesOnResume(definitionNode)) { cp.status = "cancelled"; cp.endedAt = new Date().toISOString(); continue; }
          // Tool nodes are never replayed or assumed stopped.
          if (!isJob) throw new Error("Cancellation requested, but interrupted work has an uncertain outcome; not claiming it stopped.");
          // Stop the attempt the checkpoint recorded (old checkpoints carry `-1`).
          const requestId = cp.job?.requestId ?? jobRequestId(run.id, cp.id, cp.attempt ?? 1, visitJobScope(visit));
          if (!jobDeps) throw new Error(`Cancellation requested, but node ${cp.id} has a running job (${requestId}) and this context has no background-job support to stop it; not claiming it stopped. Cancel from a context with job support.`);
          const outcome = await stopJobNodeOutcome(jobDeps, { requestId, jobId: cp.job?.jobId });
          applyJobOutcome(cp, outcome);
          await store.save(run); // Real outcome (or the kept linkage/reason) is durable before anything else.
          if (outcome.status === "incomplete") throw new JobCancellationIncompleteError(cp.id, outcome.error ?? "termination not confirmed");
        }
        // Body nodes parked on a decision (approvals, tool consent) can never be decided once the run is cancelled.
        const now = new Date().toISOString();
        for (const visit of visits) {
          if (visit.loops.length === 0 || visit.node.type === "loop" || visit.cp.status !== "waiting_approval") continue;
          visit.cp.status = "cancelled"; visit.cp.endedAt = now; visit.cp.error = "Cancelled while waiting for a decision.";
          delete visit.cp.decisionId;
        }
        // Settle running or parked loops (innermost first) whose current iteration has no work left in progress.
        for (const visit of [...visits].reverse()) {
          const loop = visit.cp as LoopNodeCheckpoint;
          if (visit.node.type !== "loop" || (loop.status !== "running" && loop.status !== "waiting_approval")) continue;
          const current = loop.iterations?.[loop.iterations.length - 1];
          if (current && ["pending", "running", "waiting_approval"].includes(current.status)) {
            if (Object.values(current.nodes).some(child => child.status === "running" || child.status === "waiting_approval")) continue;
            current.status = "cancelled"; current.endedAt = now;
          }
          loop.status = "cancelled"; loop.endedAt = now;
        }
        if (!["passed", "failed", "cancelled", "timed_out"].includes(run.status)) {
          run.status = "cancelled";
          await store.save(run);
          // No runner settles a parked run, so announce it here (create-once: a duplicate from the runner is a no-op).
          await postRunNotification(store, run);
        }
        return run;
      });
    } catch (error) {
      if (!(error instanceof BackgroundJobError) || error.code !== "lock-held") throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
