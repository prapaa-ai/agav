import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isLiveLifecycle, isTerminalLifecycle, BackgroundJobError, DEFAULT_RESOURCE_LIMITS } from "../background-jobs/types.js";
import { createBuiltinToolRegistry } from "../tools/registry-factory.js";
import { WORKFLOW_TOOLS } from "./definition.js";
import { appendEvent, readEvents } from "./events.js";
import { getNodeExecutor, retriesOnResume } from "./executors.js";
import { findRunnerJob, launchRun, liveRunnerCount, updateRun, DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS, type LaunchDeps } from "./launch.js";
import { runnerRequestId, scopedCheckpoints, type WorkflowRun, type WorkflowStore } from "./store.js";
import { hasUnappliedDecision, parkUncertainNodes } from "./decisions.js";
import { mailboxDir, postRunNotification } from "./notify.js";

/** Automatic relaunches after the runner died; beyond this the run stays `interrupted`. */
export const MAX_RUNNER_RELAUNCHES = 3;

export type ReconcileAction =
  | "none" // not a background run with a runner, terminal, parked, or its runner is live
  | "relaunched" // runner gone: interrupted, then attempt+1 launched (or queued)
  | "interrupted" // runner gone and not relaunched (bound reached or an uncertain tool node)
  | "interrupted-unknown" // runner state uncertain: never relaunched automatically
  | "admitted" // queued run started
  | "queued" // queued run still waiting for pool room
  | "parked" // runner gone with an interrupted tool node: waiting on an `uncertain_tool` decision
  | "timed_out" // parked run whose deadlineAt passed with no live runner
  | "pruned" // terminal run older than the retention window: checkpoint and run files deleted
  | "busy"; // run lock held: a live writer owns it

/**
 * Launch deps plus the environment capability of the process doing the admitting. The coordinator resolves a run's
 * selected `envInherit` names from ITS process environment, so a restricted context (a finishing runner only holds
 * its own run's selected names) cannot start a run that selected others: the values would be silently dropped.
 */
export interface ReconcileDeps extends LaunchDeps {
  /** Environment the launched runner's selected names are resolved from; defaults to `process.env` (what the coordinator reads). Values are only checked for presence, never stored. */
  admissionEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ReconcileResult { runId: string; action: ReconcileAction; reason?: string }

export interface ReconcileOptions {
  /** Terminal runs not updated for this many days are pruned (default: background-jobs `completedLogRetentionDays`). */
  retentionDays?: number;
  /** Clock override (ms since epoch), for tests. */
  now?: number;
}

const TERMINAL_RUN = new Set(["passed", "failed", "cancelled", "timed_out"]);

/** A running node that can neither be reattached (job) nor safely re-run (retry-safe agent/prompt) has an uncertain outcome. */
function isUncertain(run: WorkflowRun, cp: WorkflowRun["nodes"][number]): boolean {
  // Body checkpoints of loop iterations are included (ids are unique across the definition).
  const node = scopedCheckpoints(run).find(visit => visit.cp === cp)?.node;
  return !!node && cp.status === "running" && getNodeExecutor(node.type).resumable !== true && !retriesOnResume(node);
}
/** The engine refuses to replay an uncertain node, at top level or inside a loop iteration (a running loop node itself is resumable). */
function hasUncertainNode(run: WorkflowRun): boolean {
  return scopedCheckpoints(run).some(({ cp }) => isUncertain(run, cp));
}

function isLockHeld(error: unknown): boolean { return error instanceof BackgroundJobError && error.code === "lock-held"; }

/** Names the run's consent selected that this context cannot resolve (names only; never values). */
function missingEnvNames(run: WorkflowRun, deps: ReconcileDeps): string[] {
  const env = deps.admissionEnv ?? process.env;
  return (run.consent?.envNames ?? []).filter(name => env[name] === undefined);
}
function deferredReason(missing: string[]): string {
  return `waiting for a launch context that has the selected environment variable(s): ${missing.join(", ")}`;
}
/** Records why a run could not be started here, once per distinct reason (reconcile runs repeatedly). */
async function noteDeferred(store: WorkflowStore, run: WorkflowRun, reason: string): Promise<void> {
  const last = (await readEvents(store, run.id).catch(() => [])).filter(event => event.type === "run_status").at(-1);
  if (last?.type === "run_status" && last.status === run.status && last.reason === reason) return;
  await appendEvent(store, run.id, { type: "run_status", status: run.status, reason });
}

async function markInterrupted(store: WorkflowStore, deps: ReconcileDeps, runId: string, requestId: string, relaunch: boolean, reason: string): Promise<WorkflowRun | undefined> {
  let changed = false;
  const run = await updateRun(store, runId, deps.registry!, current => {
    // Only act on the snapshot we judged: same attempt, still non-terminal and not parked.
    if (current.runner?.requestId !== requestId || !["running", "queued"].includes(current.status)) return false;
    current.status = "interrupted";
    if (relaunch) {
      const attempt = current.runner.attempt + 1;
      current.runner = { attempt, requestId: runnerRequestId(runId, attempt), relaunches: current.runner.relaunches + 1 };
    }
    changed = true;
  });
  if (!changed) return undefined;
  await appendEvent(store, runId, { type: "run_status", status: "interrupted", reason });
  return run;
}

/** The runner is dead, so this lock holder is the single writer: park interrupted tool nodes on inbox decisions. */
async function parkUncertain(store: WorkflowStore, deps: ReconcileDeps, runId: string, requestId: string, reason: string): Promise<WorkflowRun | undefined> {
  const run = await store.lock(runId, async () => {
    const current = await store.read(runId, deps.registry!);
    if (current.runner?.requestId !== requestId || !["running", "queued"].includes(current.status)) return undefined;
    if ((await parkUncertainNodes(store, current, cp => isUncertain(current, cp))).length === 0) return undefined;
    current.status = "waiting_approval";
    await store.save(current);
    return current;
  });
  if (!run) return undefined;
  await appendEvent(store, runId, { type: "run_status", status: "waiting_approval", reason: `${reason}; an interrupted tool node has an uncertain outcome` });
  await postRunNotification(store, run);
  return run;
}

/** Applies the reconcile decision table to one run. */
export async function reconcileRun(store: WorkflowStore, runId: string, deps: ReconcileDeps): Promise<ReconcileResult> {
  const full: ReconcileDeps = { ...deps, registry: deps.registry ?? createBuiltinToolRegistry(WORKFLOW_TOOLS) };
  const run = await store.read(runId, full.registry!);
  if (run.runner && run.consent && run.status === "waiting_approval" && await hasUnappliedDecision(store, run)) {
    // A decision landed while the parking runner was still exiting: relaunch so it is applied (idempotent).
    const job = await findRunnerJob(full.coordinator, run);
    if (job && isLiveLifecycle(job.state)) return { runId, action: "none" };
    const missing = missingEnvNames(run, full);
    if (missing.length > 0) { await noteDeferred(store, run, deferredReason(missing)); return { runId, action: "none", reason: deferredReason(missing) }; } // stays parked; a capable context relaunches it
    try { await launchRun(store, runId, full); } catch (error) { if (isLockHeld(error)) return { runId, action: "busy" }; throw error; }
    return { runId, action: "relaunched", reason: "decided while parked" };
  }
  if (!run.runner || !run.consent || !["running", "queued"].includes(run.status)) return { runId, action: "none" };
  const job = await findRunnerJob(full.coordinator, run);
  if (job && isLiveLifecycle(job.state)) return { runId, action: "none" };
  if (!job && run.status === "queued") return admit(store, runId, full);
  try {
    if (job && !isTerminalLifecycle(job.state)) {
      // unknown / recovery-required: the first runner may still be alive; never start a second one.
      const marked = await markInterrupted(store, full, runId, run.runner.requestId, false, `runner job ${job.jobId} is ${job.state}`);
      return { runId, action: marked ? "interrupted-unknown" : "none", reason: `runner ${job.state}` };
    }
    const reason = job ? `runner job ${job.jobId} ${job.state}` : "runner job not found";
    const missing = missingEnvNames(run, full);
    if (missing.length > 0 && !hasUncertainNode(run)) {
      // Untouched (not interrupted: a non-running/queued run is never reconciled again): a capable context relaunches it.
      await noteDeferred(store, run, deferredReason(missing));
      return { runId, action: "none", reason: `${deferredReason(missing)} (${reason})` };
    }
    if (hasUncertainNode(run)) {
      // Never replayed: the run parks on an `uncertain_tool` decision; deciding it relaunches the runner.
      const parked = await parkUncertain(store, full, runId, run.runner.requestId, reason);
      return { runId, action: parked ? "parked" : "none", reason: "uncertain tool node" };
    }
    const relaunch = run.runner.relaunches < MAX_RUNNER_RELAUNCHES;
    const marked = await markInterrupted(store, full, runId, run.runner.requestId, relaunch, reason);
    if (!marked) return { runId, action: "none" };
    if (!relaunch) return { runId, action: "interrupted", reason: `relaunch bound (${MAX_RUNNER_RELAUNCHES}) reached` };
  } catch (error) {
    if (isLockHeld(error)) return { runId, action: "busy" };
    throw error;
  }
  await launchRun(store, runId, full);
  return { runId, action: "relaunched" };
}

async function admit(store: WorkflowStore, runId: string, deps: ReconcileDeps): Promise<ReconcileResult> {
  const run = await store.read(runId, deps.registry!);
  const missing = missingEnvNames(run, deps);
  if (missing.length > 0) {
    // Never start with the selected env silently dropped: stay queued, for a context that can resolve it.
    const reason = deferredReason(missing);
    await noteDeferred(store, run, reason);
    return { runId, action: "queued", reason };
  }
  try {
    const result = await launchRun(store, runId, deps);
    return { runId, action: result.status === "queued" ? "queued" : "admitted" };
  } catch (error) {
    if (isLockHeld(error)) return { runId, action: "busy" };
    throw error;
  }
}

function errorResult(runId: string, error: unknown): ReconcileResult {
  return { runId, action: "none", reason: error instanceof Error ? error.message : String(error) };
}

/**
 * A parked run whose deadline passed can never resume within its budget: mark it `timed_out`. Only under the
 * run lock (no writer) and only when its runner job is not live; pending decisions are left (a terminal run hides them).
 */
async function timeOutParked(store: WorkflowStore, runId: string, deps: LaunchDeps, now: number): Promise<ReconcileResult | undefined> {
  const snapshot = await store.read(runId, deps.registry!);
  if (snapshot.status !== "waiting_approval" || snapshot.deadlineAt === undefined || Date.parse(snapshot.deadlineAt) > now) return undefined;
  const job = await findRunnerJob(deps.coordinator, snapshot);
  if (job && !isTerminalLifecycle(job.state)) return { runId, action: "none", reason: `deadline passed; runner ${job.state}` };
  let run: WorkflowRun | undefined;
  try {
    run = await store.lock(runId, async () => {
      const current = await store.read(runId, deps.registry!);
      if (current.status !== "waiting_approval" || current.deadlineAt === undefined || Date.parse(current.deadlineAt) > now) return undefined;
      current.status = "timed_out";
      await store.save(current);
      return current;
    });
  } catch (error) {
    if (isLockHeld(error)) return { runId, action: "busy" };
    throw error;
  }
  if (!run) return undefined;
  await appendEvent(store, runId, { type: "run_status", status: "timed_out", reason: "run deadline exceeded while waiting for a decision" });
  await postRunNotification(store, run);
  return { runId, action: "timed_out" };
}

/** Deletes the run's mailbox notifications and their `.seen` markers. */
async function pruneMailbox(store: WorkflowStore, runId: string): Promise<void> {
  const dir = mailboxDir(store);
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: { runId?: unknown };
    try { record = JSON.parse(await fs.readFile(join(dir, name), "utf8")) as { runId?: unknown }; }
    catch { continue; }
    if (record?.runId !== runId) continue;
    await fs.rm(join(dir, `${name.slice(0, -5)}.seen`), { force: true });
    await fs.rm(join(dir, name), { force: true });
  }
}

/**
 * Retention: a terminal run not updated within `retentionDays` is deleted with its run dir (decisions, events,
 * artifacts), `.cancel` marker and mailbox entries. Non-terminal runs are never pruned. The checkpoint goes last
 * (under the run lock), so an interrupted prune is simply retried on the next pass.
 */
async function pruneRun(store: WorkflowStore, runId: string, deps: LaunchDeps, cutoff: number): Promise<ReconcileResult | undefined> {
  const isExpired = (run: WorkflowRun): boolean => TERMINAL_RUN.has(run.status) && Date.parse(run.updatedAt) <= cutoff;
  if (!isExpired(await store.read(runId, deps.registry!))) return undefined;
  try {
    const pruned = await store.lock(runId, async () => {
      if (!isExpired(await store.read(runId, deps.registry!))) return false;
      await pruneMailbox(store, runId);
      await fs.rm(join(store.root, `${runId}.cancel`), { force: true });
      await fs.rm(store.runDir(runId), { recursive: true, force: true });
      await fs.rm(join(store.root, `${runId}.json`), { force: true });
      return true;
    });
    return pruned ? { runId, action: "pruned" } : undefined;
  } catch (error) {
    if (isLockHeld(error)) return { runId, action: "busy" };
    throw error;
  }
}

/**
 * Admits queued runs FIFO by `createdAt` while the workflow-runner pool has room. `deps.exitingRunId` names a
 * runner that has settled and released its lock but whose process is still alive: it does not hold a slot.
 */
export async function admitQueuedRuns(store: WorkflowStore, deps: ReconcileDeps): Promise<ReconcileResult[]> {
  const full: ReconcileDeps = { ...deps, registry: deps.registry ?? createBuiltinToolRegistry(WORKFLOW_TOOLS) };
  const queued: WorkflowRun[] = [];
  for (const id of await store.listIds()) {
    const run = await store.read(id, full.registry!).catch(() => undefined);
    if (run?.runner && run.consent && run.status === "queued") queued.push(run);
  }
  const results: ReconcileResult[] = [];
  const max = full.maxConcurrentWorkflowRuns ?? DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS;
  for (const run of queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (await liveRunnerCount(store, full.coordinator, full.registry!, full.exitingRunId) >= max) break;
    try { results.push(await reconcileRun(store, run.id, full)); }
    catch (error) { results.push(errorResult(run.id, error)); }
  }
  return results;
}

/**
 * Reconciles every run: dead runners first (so freed slots are visible), parked runs past their deadline are
 * timed out, then queued runs FIFO by `createdAt` while the workflow-runner pool has room, and finally terminal
 * runs past the retention window are pruned. Per-run errors are reported, never thrown, so one bad run cannot
 * block others.
 */
export async function reconcileRuns(store: WorkflowStore, deps: ReconcileDeps, opts: ReconcileOptions = {}): Promise<ReconcileResult[]> {
  const full: ReconcileDeps = { ...deps, registry: deps.registry ?? createBuiltinToolRegistry(WORKFLOW_TOOLS) };
  const now = opts.now ?? Date.now();
  const runs: WorkflowRun[] = [];
  const terminal: WorkflowRun[] = [];
  const parked: WorkflowRun[] = [];
  for (const id of await store.listIds()) {
    const run = await store.read(id, full.registry!).catch(() => undefined);
    if (!run) continue;
    if (TERMINAL_RUN.has(run.status)) terminal.push(run);
    else if (run.status === "waiting_approval" && run.deadlineAt !== undefined && Date.parse(run.deadlineAt) <= now) parked.push(run);
    else if (run.runner && run.consent && ["running", "queued", "waiting_approval"].includes(run.status)) runs.push(run);
  }
  const results: ReconcileResult[] = [];
  const attempt = async (id: string, step: (id: string) => Promise<ReconcileResult | undefined>): Promise<void> => {
    try { const result = await step(id); if (result) results.push(result); }
    catch (error) { results.push(errorResult(id, error)); }
  };
  for (const run of runs.filter(run => run.status === "running" || run.status === "waiting_approval")) await attempt(run.id, id => reconcileRun(store, id, full));
  for (const run of parked) await attempt(run.id, id => timeOutParked(store, id, full, now));
  const max = full.maxConcurrentWorkflowRuns ?? DEFAULT_MAX_CONCURRENT_WORKFLOW_RUNS;
  for (const run of runs.filter(run => run.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (await liveRunnerCount(store, full.coordinator, full.registry!, full.exitingRunId) >= max) break;
    await attempt(run.id, id => reconcileRun(store, id, full));
  }
  const retentionDays = opts.retentionDays ?? DEFAULT_RESOURCE_LIMITS.completedLogRetentionDays;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  for (const run of terminal) await attempt(run.id, id => pruneRun(store, id, full, cutoff));
  return results;
}
