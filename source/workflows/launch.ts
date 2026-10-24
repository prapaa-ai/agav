import { isLiveLifecycle, isTerminalLifecycle, type CoordinatorClient, type JobSummary, type SessionPolicySnapshot, type StartJobRequest } from "../background-jobs/types.js";
import { getNodeEntryLoaderArgs, getWorkflowRunnerArgs, isStandaloneBinary } from "../background-jobs/packaging/manifest.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import type { ToolRegistry } from "../tools/registry.js";
import { WORKFLOW_TOOLS } from "./definition.js";
import { appendEvent } from "./events.js";
import { runnerRequestId, type WorkflowRun, type WorkflowStore } from "./store.js";

export const DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS = 2;
const TERMINAL_RUN = new Set(["passed", "failed", "cancelled", "timed_out"]);

/** Optional capabilities preserve minimal clients; Windows supports an explicitly unverified fallback. */
export type RunnerCoordinator = Pick<CoordinatorClient, "start" | "poll" | "stop" | "findByRequestId"> & Partial<Pick<CoordinatorClient, "capabilities">>;
const warnedWindowsCoordinators = new WeakSet<RunnerCoordinator>();

/** Share the availability policy between consent preflight and every launch/relaunch. */
export async function assertBackgroundRunsAvailable(coordinator: RunnerCoordinator): Promise<void> {
  const capabilities = await coordinator.capabilities?.();
  if (capabilities?.platform === "win32") {
    if (!warnedWindowsCoordinators.has(coordinator)) {
      process.stderr.write("Warning: Windows workflow runners and job nodes run unsandboxed. Docker is the only supported Windows sandbox override for run_command; it does not sandbox the workflow runner or job nodes. No native Job Object helper is bundled: process-tree ownership and descendant cleanup are not guaranteed. sandboxRequired remains enforced.\n");
      warnedWindowsCoordinators.add(coordinator);
    }
    return;
  }
  if (capabilities?.nativeHelperAvailable === false) {
    throw new Error(`Background workflow runs are unavailable on this host: the native process helper is missing${capabilities.limitations.length ? ` (${capabilities.limitations.join("; ")})` : ""}.`);
  }
}

export interface LaunchDeps {
  coordinator: RunnerCoordinator;
  /** Session for the runner `start`; defaults to `runnerLaunchSession()`. */
  session?: SessionPolicySnapshot;
  /** CLI entry script re-executed by `process.execPath`; ignored by standalone binaries, which re-execute themselves. */
  cliPath: string;
  maxConcurrentWorkflowRuns?: number;
  registry?: ToolRegistry;
  /**
   * Start the next attempt even when the existing runner job's state is uncertain (unknown/recovery-required),
   * i.e. it may still be alive. Only for an explicit user override; never set by automatic reconcile.
   */
  force?: boolean;
  /** A run whose runner is exiting (settled/parked, lock released): its still-live job does not hold a pool slot. */
  exitingRunId?: string;
  /** The caller's effective sandboxRequired; it can only strengthen the run's persisted requirement (never read from process state: a runner admitting another run must not leak its own). */
  sandboxRequired?: boolean;
}
export interface LaunchResult { status: "started" | "attached" | "queued"; run: WorkflowRun; job?: JobSummary }

/**
 * Headless snapshot for launching a run's own runner. The run's per-invocation consent (`run.consent`) is the
 * user's approval, so no prompt is possible or needed; it covers only the runner request built below.
 */
export function runnerLaunchSession(): SessionPolicySnapshot {
  return { permissionMode: "auto-accept", headlessApprovedActions: ["workflow-run", "start", "headless-start"] };
}

/** The supervised runner job for the run's current attempt. */
export function runnerStartRequest(run: WorkflowRun, cliPath: string, standalone: boolean = isStandaloneBinary()): StartJobRequest {
  if (!run.runner) throw new Error(`Workflow run ${run.id} has no runner attempt.`);
  if (!run.consent) throw new Error(`Workflow run ${run.id} has no background consent; refusing to launch.`);
  return {
    requestId: run.runner.requestId,
    invocation: { mode: "direct", executable: process.execPath, args: getWorkflowRunnerArgs(run.id, standalone ? undefined : cliPath, standalone ? [] : getNodeEntryLoaderArgs(cliPath)) },
    cwd: run.cwd,
    envInherit: [...run.consent.envNames],
    isolation: { backend: "none", required: false },
    headless: true,
  };
}

/** The runner job for the run's current attempt, or undefined when none exists. */
export async function findRunnerJob(coordinator: RunnerCoordinator, run: WorkflowRun): Promise<JobSummary | undefined> {
  if (!run.runner) return undefined;
  if (!coordinator.findByRequestId) throw new Error("The background-job coordinator cannot look up runner jobs by requestId.");
  const found = await coordinator.findByRequestId(run.runner.requestId);
  return found && found.requestId === run.runner.requestId ? found : undefined;
}

/** Runs (other than `exceptId`) whose runner job is live; unreadable checkpoints are skipped. */
export async function liveRunnerCount(store: WorkflowStore, coordinator: RunnerCoordinator, registry: ToolRegistry, exceptId?: string | string[]): Promise<number> {
  const except = new Set(exceptId === undefined ? [] : Array.isArray(exceptId) ? exceptId : [exceptId]);
  let live = 0;
  for (const id of await store.listIds()) {
    if (except.has(id)) continue;
    const run = await store.read(id, registry).catch(() => undefined);
    if (!run?.runner) continue;
    const job = await findRunnerJob(coordinator, run).catch(() => undefined);
    if (job && isLiveLifecycle(job.state)) live++;
  }
  return live;
}

/** Re-reads under the run lock, applies `mutate`, and saves; never writes a stale snapshot over another writer. */
export async function updateRun(store: WorkflowStore, id: string, registry: ToolRegistry, mutate: (run: WorkflowRun) => boolean | void): Promise<WorkflowRun> {
  return store.lock(id, async () => {
    const run = await store.read(id, registry);
    if (mutate(run) !== false) await store.save(run);
    return run;
  });
}

/**
 * Records the caller's stricter requirement on a run that is being reattached instead of (re)launched, so a later
 * relaunch enforces it. Fails closed: if it cannot be persisted (lock held, disk error) the error propagates rather
 * than reporting an attach that silently dropped the requirement. Never weakens; a run already strict is untouched.
 */
async function strengthenRequirement(store: WorkflowStore, run: WorkflowRun, deps: LaunchDeps, registry: ToolRegistry): Promise<WorkflowRun> {
  if (deps.sandboxRequired !== true || run.sandboxRequired === true) return run;
  return updateRun(store, run.id, registry, current => {
    if (TERMINAL_RUN.has(current.status) || current.sandboxRequired === true) return false;
    current.sandboxRequired = true;
  });
}

/**
 * Ensures the run's current runner attempt exists. Idempotent: an existing runner job (found by its deterministic
 * requestId) is reattached, never started twice. A full workflow-runner pool leaves the run `queued`, never failed.
 */
export async function launchRun(store: WorkflowStore, runId: string, deps: LaunchDeps): Promise<LaunchResult> {
  const registry = deps.registry ?? createBuiltinToolRegistry(WORKFLOW_TOOLS);
  let run = await store.read(runId, registry);
  if (!run.consent) throw new Error(`Workflow run ${runId} has no background consent; refusing to launch.`);
  if (TERMINAL_RUN.has(run.status)) return { status: "attached", run };
  const existing = await findRunnerJob(deps.coordinator, run);
  // A live attempt, or a dead one while the run still claims running/queued (reconcile decides those), is reattached.
  if (existing && (isLiveLifecycle(existing.state) || ["running", "queued"].includes(run.status))) return { status: "attached", run: await strengthenRequirement(store, run, deps, registry), job: existing };
  // An uncertain runner (unknown/recovery-required) may still be executing: a second one would race it.
  if (existing && !isTerminalLifecycle(existing.state) && deps.force !== true) {
    throw new Error(`Workflow run ${runId}: runner job ${existing.jobId} is ${existing.state} and may still be running; refusing to start another runner. Verify it has stopped, then retry with force.`);
  }
  // A finished attempt of a parked/interrupted run: the next launch is a new attempt (requestIds are never reused).
  const nextAttempt = existing ? run.runner!.attempt + 1 : undefined;

  await assertBackgroundRunsAvailable(deps.coordinator);

  const max = deps.maxConcurrentWorkflowRuns ?? DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS;
  const full = await liveRunnerCount(store, deps.coordinator, registry, deps.exitingRunId ? [runId, deps.exitingRunId] : runId) >= max;
  const previous = run.status;
  // Durable intent (status + deterministic requestId) before any start, so a crash stays recoverable.
  run = await updateRun(store, runId, registry, current => {
    if (TERMINAL_RUN.has(current.status)) return false;
    if (nextAttempt !== undefined && current.runner?.attempt === nextAttempt - 1) current.runner = { ...current.runner, attempt: nextAttempt, requestId: runnerRequestId(runId, nextAttempt), jobId: undefined };
    current.runner ??= { attempt: 1, requestId: runnerRequestId(runId, 1), relaunches: 0 };
    if (current.runner.jobId === undefined) delete current.runner.jobId;
    current.status = "queued";
    // Persist the stricter requirement so the detached runner enforces it on this and every later attempt; never weakened.
    if (deps.sandboxRequired === true) current.sandboxRequired = true;
  });
  if (TERMINAL_RUN.has(run.status)) return { status: "attached", run };
  if (previous !== "queued") await appendEvent(store, runId, { type: "run_status", status: "queued", ...(full ? { reason: "workflow runner pool full" } : {}) });
  if (full) return { status: "queued", run };

  const request = runnerStartRequest(run, deps.cliPath);
  let job: JobSummary;
  try {
    job = await deps.coordinator.start(request, deps.session ?? runnerLaunchSession());
  } catch (error) {
    // The coordinator may have admitted the runner before throwing: look before reporting failure.
    const found = await findRunnerJob(deps.coordinator, run).catch(() => undefined);
    if (!found) throw error;
    job = found;
  }
  // Best effort: the runner may already hold the lock; the requestId alone is enough to reattach.
  try {
    run = await updateRun(store, runId, registry, current => {
      if (current.runner?.requestId !== request.requestId || current.runner.jobId === job.jobId) return false;
      current.runner.jobId = job.jobId;
    });
  } catch { /* lock held by the live runner */ }
  return { status: "started", run, job };
}
