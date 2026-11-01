import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkflowExecutionHost } from "./gated-tools.js";
import { definitionHash, scopedCheckpoints, toleratedFailure, type JobScope, type LoopNodeCheckpoint, type NodeCheckpoint, type NodeStatus, type RunHost, type RunStatus, type WorkflowRun, WorkflowStore } from "./store.js";
import { type JobNodeDeps } from "./job-node.js";
import { settleLoopVisits, settleParkedBody, stopLiveJobs } from "./loop-node.js";
import { narrowPermissionMode, type WorkflowDefinition, type WorkflowNode } from "./definition.js";
import { getNodeExecutor, retriesOnResume, type NodeResult } from "./executors.js";
import { type AgentNodeDeps } from "./agent-node.js";
import type { TemplateContext } from "./interpolate.js";
import { evaluateCondition } from "./expr.js";
import { resolveInputs } from "./inputs.js";
import { appendEvent } from "./events.js";
import { applyDecisions, hasUnappliedDecision, parkUncertainNodes } from "./decisions.js";

/** Creates a pending run; provided inputs are checked against the definition's typed inputs (defaults applied). */
export async function createRun(store: WorkflowStore, definition: WorkflowDefinition, inputs: Record<string, unknown>, options: { host?: RunHost } = {}): Promise<WorkflowRun> {
  const resolved = resolveInputs(definition, inputs);
  const now = new Date().toISOString();
  const run: WorkflowRun = { version: 1, id: randomUUID(), definition, workflowHash: definitionHash(definition), cwd: await realpath(process.cwd()), inputs: resolved, status: "pending", nodes: definition.nodes.map(node => ({ id: node.id, status: "pending" })), createdAt: now, updatedAt: now, ...(options.host ? { host: options.host } : {}) };
  await store.lock(run.id, () => store.save(run));
  return run;
}
/** Node statuses after which a node will not change again in this run (dependents may be decided). */
const SETTLED = new Set<NodeStatus>(["passed", "skipped", "failed", "timed_out", "cancelled"]);

/** Cancellable sleep: resolves early (without throwing) when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Why a ready node (every dependency settled) must be skipped instead of executed, or undefined to run it.
 * A failed/timed-out/cancelled dependency (only reachable with `stopOnFailure: false`) skips its dependents,
 * except a tolerated `continueOnError` failure, which satisfies them (they can branch on its status with `when`);
 * a skipped dependency is satisfied only with `allowSkipped: true`, otherwise the skip cascades. Finally a
 * false `when` skips the node itself. A missing reference in `when` is undefined, never an error.
 */
export function skipReason(run: WorkflowRun, node: WorkflowNode): string | undefined {
  return scopeSkipReason(run, { nodes: run.definition.nodes, checkpoints: Object.fromEntries(run.nodes.map(cp => [cp.id, cp])) }, node);
}

/** `skipReason` within one scope: dependencies resolve in `spec.checkpoints`; `when` also sees `outerNodes` and `loop`. */
function scopeSkipReason(run: WorkflowRun, spec: ScopeSpec, node: WorkflowNode): string | undefined {
  for (const dep of node.dependsOn ?? []) {
    const depCp = spec.checkpoints[dep]!;
    if (toleratedFailure(spec.nodes.find(candidate => candidate.id === dep), depCp)) continue;
    const status = depCp.status;
    if (status === "failed" || status === "timed_out" || status === "cancelled") return `dependency ${dep} ${status}`;
    if (status === "skipped" && node.allowSkipped !== true) return `dependency ${dep} was skipped`;
  }
  if (node.when !== undefined && !evaluateCondition(node.when, scopeTemplateContext(run, spec))) return `when is false: ${node.when}`;
  return undefined;
}

/** Interpolation context for a scope: run inputs, outer checkpoints overlaid by the scope's own, and the loop context. */
function scopeTemplateContext(run: WorkflowRun, spec: ScopeSpec): TemplateContext {
  const view = (cps: Record<string, NodeCheckpoint>): Array<[string, { status: string; output?: unknown }]> => Object.values(cps).map(cp => [cp.id, { status: cp.status, output: cp.output }]);
  return { inputs: run.inputs, nodes: Object.fromEntries([...view(spec.outerNodes ?? {}), ...view(spec.checkpoints)]), ...(spec.loop ? { loop: spec.loop } : {}) };
}

/** True when a settled attempt may be retried: retry budget left, not cancelled, and no possibly-live job behind it. */
function shouldRetry(node: WorkflowNode, cp: NodeCheckpoint, signal: AbortSignal): boolean {
  if (!node.retry || signal.aborted || (cp.status !== "failed" && cp.status !== "timed_out")) return false;
  if ((cp.attempt ?? 1) > node.retry.max) return false;
  // An uncertain job outcome (unknown state, unverifiable start) may still be running: never start a second workload.
  if (node.type === "job" && (cp.error ?? "").startsWith("uncertain")) return false;
  return true;
}

/** Job deps whose session permission mode is narrowed like the run config (deny-writes blocks `start`). */
function narrowJobDeps(deps: JobNodeDeps | undefined, mode: PermissionMode | undefined): JobNodeDeps | undefined {
  if (!deps || mode === undefined) return deps;
  const base = deps.session;
  return { ...deps, session: () => { const session = typeof base === "function" ? base() : base; return { ...session, permissionMode: narrowPermissionMode(session.permissionMode, mode) }; } };
}

/** Maximum executor dispatches (including retries and resumed reattachments) over a run's lifetime. */
export const MAX_EXECUTIONS = 500;
const CAP_ERROR = `execution cap (${MAX_EXECUTIONS}) exceeded`;

/** One sibling scope to schedule: the top-level DAG or one loop iteration's body. */
export interface ScopeSpec {
  nodes: WorkflowNode[];
  /** Checkpoints of `nodes`, keyed by node id (mutated in place; persisted via `env.save`). */
  checkpoints: Record<string, NodeCheckpoint>;
  loop?: TemplateContext["loop"];
  jobScope?: JobScope;
  /** Checkpoints of enclosing scopes, visible to `when` under the scope's own. */
  outerNodes?: Record<string, NodeCheckpoint>;
}
/** Run-wide context shared by every scope of one execution. */
export interface ScopeEnv {
  run: WorkflowRun;
  store: WorkflowStore;
  registry: ToolRegistry;
  config: AgavConfig;
  /** Run-level abort (caller signal, durable cancel marker, or run deadline). */
  signal: AbortSignal;
  host?: WorkflowExecutionHost;
  jobDeps?: JobNodeDeps;
  agentDeps?: AgentNodeDeps;
  save(): Promise<void>;
  stopOnFailure: boolean;
  maxRuntimeSeconds?: number;
  /** True once the run deadline aborted `signal`. */
  deadlineHit(): boolean;
  /** A running resumable checkpoint to reattach before scheduling anything else; consumed (cleared) on use. */
  resume?: NodeCheckpoint;
  /** Between-node hook (cancel marker, decisions applied by other sessions); true stops scheduling. */
  betweenNodes?(): Promise<boolean>;
  /** Set when the execution cap stopped the run. */
  capExceeded?: boolean;
}
export type ScopeStatus = "passed" | "failed" | "timed_out" | "waiting_approval" | "cancelled";

/**
 * Sequential scheduler for one scope: dependency readiness, when/skip cascade, retries with backoff,
 * deadline timeouts, parking on pending decisions and executor dispatch. Returns the scope's derived status.
 */
export async function runScope(spec: ScopeSpec, env: ScopeEnv): Promise<ScopeStatus> {
  const { run, store, registry, config, host, jobDeps, agentDeps, stopOnFailure } = env;
  const signal = env.signal;
  const cps = spec.checkpoints;
  const finish = async (status: ScopeStatus): Promise<ScopeStatus> => status;
  const finalStatus = (): ScopeStatus => {
    // Tolerated (continueOnError) failures do not fail the scope.
    const all = spec.nodes.map(node => cps[node.id]!).filter((cp, i) => !toleratedFailure(spec.nodes[i], cp));
    if (env.capExceeded) return "failed";
    if (env.deadlineHit()) return "timed_out";
    if (signal.aborted) return "cancelled";
    // With stopOnFailure:false independent branches still parked on decisions keep the run waiting.
    if (!stopOnFailure && all.some(cp => cp.status === "waiting_approval")) return "waiting_approval";
    if (all.some(cp => cp.status === "timed_out")) return "timed_out";
    if (all.some(cp => cp.status === "failed")) return "failed";
    if (all.some(cp => cp.status === "cancelled")) return "cancelled";
    return all.every(cp => cp.status === "passed" || cp.status === "skipped") ? "passed" : "waiting_approval";
  };
  while (env.resume !== undefined || !signal.aborted) {
    if (env.resume === undefined && env.betweenNodes && await env.betweenNodes()) break;
    const resumeCp = env.resume;
    // A failure already durable in this scope (e.g. a denied approval applied on resume) stops scheduling under stopOnFailure:
    // dependents stay pending, never skipped (a skipped node with a failed dependency is unreadable under stopOnFailure).
    if (resumeCp === undefined && stopOnFailure && spec.nodes.some(candidate => ["failed", "timed_out", "cancelled"].includes(cps[candidate.id]!.status) && !toleratedFailure(candidate, cps[candidate.id]!))) break;
    const node = resumeCp !== undefined
      ? spec.nodes.find(candidate => candidate.id === resumeCp.id)
      // A running loop (re-armed by a decision inside its body, or interrupted) is re-entered to continue its iteration.
      : spec.nodes.find(candidate => (cps[candidate.id]!.status === "pending" || (candidate.type === "loop" && cps[candidate.id]!.status === "running")) && (candidate.dependsOn ?? []).every(dep => SETTLED.has(cps[dep]!.status)));
    if (!node) break;
    const cp = cps[node.id]!;
    const resuming = resumeCp !== undefined;
    env.resume = undefined;
    if (!resuming) {
      let reason: string | undefined;
      try { reason = scopeSkipReason(run, spec, node); }
      catch (error) { reason = undefined; cp.status = "failed"; cp.error = `when could not be evaluated: ${error instanceof Error ? error.message : String(error)}`; }
      if (reason !== undefined || cp.status === "failed") {
        if (reason !== undefined) { cp.status = "skipped"; cp.error = `Skipped: ${reason}.`; }
        cp.endedAt = new Date().toISOString();
        await env.save();
        await appendEvent(store, run.id, { type: "node_completed", nodeId: node.id, status: cp.status, ...(cp.error ? { error: cp.error } : {}) });
        if (cp.status === "failed" && stopOnFailure && !toleratedFailure(node, cp)) break;
        continue;
      }
      if (node.retry && cp.attempt === undefined) cp.attempt = 1;
    }
    const executor = getNodeExecutor(node.type);
    let result: NodeResult | undefined;
    let first = true;
    for (;;) {
      // A reattached job is counted but never failed by the cap (its workload may be live).
      if ((run.executionCount ?? 0) >= MAX_EXECUTIONS && !(resuming && first)) {
        env.capExceeded = true;
        // A loop may still own live jobs, running iterations and parked decisions: stop and settle them first (fail closed:
        // an unconfirmed stop throws and leaves the run non-terminal), or the failed loop would be unreadable / leak a workload.
        if (node.type === "loop") {
          await stopLiveJobsBeforeTerminal(store, run, env.jobDeps);
          await settleParkedBody(store, run.id, { [cp.id]: cp }, new Date().toISOString());
        }
        cp.status = "failed"; cp.error = CAP_ERROR; cp.endedAt = new Date().toISOString();
        await env.save();
        await appendEvent(store, run.id, { type: "node_completed", nodeId: node.id, status: cp.status, error: cp.error });
        break;
      }
      run.executionCount = (run.executionCount ?? 0) + 1;
      if (!resuming || !first) await appendEvent(store, run.id, { type: "node_started", nodeId: node.id, ...(cp.attempt !== undefined ? { attempt: cp.attempt } : {}) });
      result = await executor.execute({ store, run, node, checkpoint: cp, registry, config, signal, host, jobDeps, agentDeps, resuming: resuming && first, ...(spec.loop ? { loop: spec.loop } : {}), ...(spec.jobScope ? { jobScope: spec.jobScope, iteration: spec.jobScope.loopPath.map(step => step.iteration) } : {}), scopeNodes: { ...spec.outerNodes, ...cps }, runSubScope: (sub, options) => runSubScope(sub, env, options) });
      first = false;
      // The run deadline aborted this node: it timed out rather than being cancelled by a user.
      if (env.deadlineHit() && cp.status === "cancelled") {
        cp.status = "timed_out"; cp.error = `Run deadline exceeded (policies.maxRuntimeSeconds=${env.maxRuntimeSeconds}).${cp.error ? ` ${cp.error}` : ""}`;
        await env.save();
      }
      if (!["pending", "running", "waiting_approval"].includes(cp.status)) await appendEvent(store, run.id, { type: "node_completed", nodeId: node.id, status: cp.status, ...(cp.error ? { error: cp.error } : {}) });
      if (!shouldRetry(node, cp, signal)) break;
      // Durable retry intent first: a crash during backoff resumes with the next attempt (and a new job requestId).
      const failure = cp.error;
      cp.attempt = (cp.attempt ?? 1) + 1;
      cp.status = "pending";
      for (const key of ["output", "error", "startedAt", "endedAt", "usage", "model", "durationMs", "job"] as const) delete cp[key];
      await env.save();
      await appendEvent(store, run.id, { type: "node_retry", nodeId: node.id, attempt: cp.attempt, ...(failure ? { error: failure } : {}) });
      await sleep((node.retry!.backoffSeconds ?? 0) * 1000, signal);
      if (signal.aborted) break;
    }
    if (env.capExceeded) break;
    if (signal.aborted && cp.status === "pending") break;
    // With stopOnFailure:false a failed or timed-out node only skips its dependents; other branches continue.
    // A tolerated (continueOnError) failure never stops scheduling.
    if (result!.next === "stop" && !toleratedFailure(node, cp) && (stopOnFailure || !["failed", "timed_out"].includes(cp.status))) break;
  }
  return finish(finalStatus());
}

/** Runs a nested scope (loop body) sharing `env`; an optional own abort signal (loop timeout) and resumed checkpoint. */
async function runSubScope(spec: ScopeSpec, env: ScopeEnv, options: { resume?: NodeCheckpoint; signal?: AbortSignal } = {}): Promise<ScopeStatus> {
  const sub: ScopeEnv = { ...env, signal: options.signal ?? env.signal, resume: options.resume };
  try { return await runScope(spec, sub); }
  finally { if (sub.capExceeded) env.capExceeded = true; }
}

/**
 * Before a resumed run is made terminal without scheduling anything (an earlier denial/failure stops it), stops every
 * job still running (top level or inside loop bodies) and settles the enclosing loops, so terminalizing never leaves a
 * live workload behind a terminal run (a later cancel skips terminal runs). Mirrors cancelRun: a stop that is not
 * confirmed throws `JobCancellationIncompleteError` and leaves the run non-terminal with its job linkage so resume or
 * cancel can retry; without job support nothing is claimed stopped either.
 */
async function stopLiveJobsBeforeTerminal(store: WorkflowStore, run: WorkflowRun, jobDeps: JobNodeDeps | undefined): Promise<void> {
  const visits = scopedCheckpoints(run);
  await stopLiveJobs(store, run, jobDeps, visits);
  await settleLoopVisits(store, run, visits, new Date().toISOString());
  await store.save(run);
}

/** Sequential DAG execution; the exclusive run lock spans work and shutdown settlement. */
export async function executeRun(store: WorkflowStore, id: string, registry: ToolRegistry, sessionConfig: AgavConfig, signal?: AbortSignal, host?: WorkflowExecutionHost, sessionJobDeps?: JobNodeDeps, agentDeps?: AgentNodeDeps): Promise<WorkflowRun> {
  return store.lock(id, async () => {
    const run = await store.read(id, registry);
    if (await realpath(process.cwd()) !== run.cwd) throw new Error(`Resume must use the original working directory: ${run.cwd}`);
    if (["passed", "failed", "cancelled", "timed_out"].includes(run.status)) return run;
    const policies = run.definition.policies ?? {};
    const stopOnFailure = policies.stopOnFailure !== false;
    // policies.permissionMode can only narrow the session's (or the run consent's) mode, never widen it.
    const config: AgavConfig = { ...sessionConfig, permissionMode: narrowPermissionMode(sessionConfig.permissionMode, policies.permissionMode) };
    const jobDeps = narrowJobDeps(sessionJobDeps, policies.permissionMode);
    await store.hydrateOutputs(run); // Executors interpolate real outputs, never artifact references.
    // Tool nodes are never replayed. A running job node is instead reattached below via its durable requestId.
    // The slot goes to a running job before any running loop: the scheduler re-enters a running loop by itself, but nothing
    // re-enters a running job. A loop is the fallback target (reattached even at the execution cap) when no job is running.
    const resumables = run.nodes.map(cp => ({ cp, type: run.definition.nodes.find(node => node.id === cp.id)!.type })).filter(({ cp, type }) => cp.status === "running" && getNodeExecutor(type).resumable === true);
    const resumedJob = (resumables.find(({ type }) => type !== "loop") ?? resumables[0])?.cp;
    // A retry-safe agent/prompt node (retrySafe !== false) is simply dispatched again from scratch.
    // Body checkpoints of loop iterations follow the same rules (the running loop itself is re-entered).
    let dirty = false;
    for (const { cp, node } of scopedCheckpoints(run)) {
      if (cp.status !== "running" || cp === resumedJob || !retriesOnResume(node)) continue;
      cp.status = "pending";
      for (const key of ["output", "error", "startedAt", "endedAt", "usage", "model", "durationMs"] as const) delete cp[key];
      dirty = true;
    }
    // An interrupted tool (or retrySafe:false agent) becomes an `uncertain_tool` inbox decision (approve retries, deny fails); never auto-replayed.
    const leafResumable = new Set(scopedCheckpoints(run).filter(({ node }) => getNodeExecutor(node.type).resumable === true).map(({ cp }) => cp));
    if ((await parkUncertainNodes(store, run, cp => cp !== resumedJob && !leafResumable.has(cp))).length > 0) dirty = true;
    // Decisions recorded while no runner was live (the decider never writes run.json).
    if (await applyDecisions(store, run)) dirty = true;
    // The run deadline is fixed at the first execution and persisted, so a resumed run keeps the original budget.
    if (policies.maxRuntimeSeconds !== undefined && run.deadlineAt === undefined) {
      run.deadlineAt = new Date(Date.now() + policies.maxRuntimeSeconds * 1000).toISOString();
      dirty = true;
    }
    if (dirty) await store.save(run);
    // A crash can occur after a failed node is durable but before the run's
    // terminal status is saved. Never dispatch another branch on resume
    // (with stopOnFailure:false a failed/timed-out node only skips its dependents).
    const stopped = run.nodes.find((node, i) => node.status === "cancelled" || (stopOnFailure && (node.status === "failed" || node.status === "timed_out") && !toleratedFailure(run.definition.nodes[i], node)));
    if (stopped) {
      await stopLiveJobsBeforeTerminal(store, run, jobDeps);
      run.status = stopped.status as RunStatus;
      await store.save(run);
      await appendEvent(store, id, { type: "run_status", status: run.status });
      return run;
    }
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    // Run deadline: aborts the running node; the run (and the interrupted node) end `timed_out`.
    let deadlineHit = false;
    const hitDeadline = (): void => { deadlineHit = true; abort(); };
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (run.deadlineAt !== undefined) {
      const remaining = Date.parse(run.deadlineAt) - Date.now();
      if (remaining <= 0) hitDeadline();
      // setTimeout's max delay is ~24.8 days; policies.maxRuntimeSeconds is capped at 7 days.
      else deadlineTimer = setTimeout(hitDeadline, remaining);
    }
    let pollingError: unknown;
    let polling = Promise.resolve();
    // Set by the poller when a waiting node's decision was decided by another session; applied between nodes.
    let decisionReady = false;
    const timer = setInterval(() => {
      polling = polling.then(async () => {
        if (await store.cancellationRequested(id)) abort();
        if (!decisionReady && await hasUnappliedDecision(store, run)) decisionReady = true;
      }).catch(error => { pollingError = error; abort(); });
    }, 100);
    const failureStops = (): boolean => stopOnFailure && run.nodes.some((cp, i) => cp.status === "failed" && !toleratedFailure(run.definition.nodes[i], cp));
    const env: ScopeEnv = {
      run, store, registry, config, signal: controller.signal, host, jobDeps, agentDeps,
      save: () => store.save(run),
      stopOnFailure, maxRuntimeSeconds: policies.maxRuntimeSeconds, deadlineHit: () => deadlineHit,
      resume: resumedJob,
      async betweenNodes() {
        if (await store.cancellationRequested(id)) { abort(); return true; }
        if (decisionReady) {
          decisionReady = false;
          if (await applyDecisions(store, run)) await store.save(run);
          if (failureStops()) return true;
        }
        return false;
      },
    };
    try {
      if (await store.cancellationRequested(id)) abort();
      for (;;) {
        run.status = "running";
        await store.save(run);
        await appendEvent(store, id, { type: "run_status", status: "running" });
        const scopeStatus = await runScope({ nodes: run.definition.nodes, checkpoints: Object.fromEntries(run.nodes.map(cp => [cp.id, cp])) }, env);
        if (pollingError) throw pollingError;
        if (env.capExceeded) await stopLiveJobsBeforeTerminal(store, run, jobDeps);
        run.status = scopeStatus;
        await store.save(run);
        await appendEvent(store, id, { type: "run_status", status: run.status, ...(deadlineHit ? { reason: "run deadline exceeded" } : env.capExceeded ? { reason: CAP_ERROR } : {}) });
        // Parked. A decider that saw this runner live does not relaunch, so re-check once the park is durable:
        // a decision written before this point is applied now instead of being stranded.
        if (run.status !== "waiting_approval" || !await applyDecisions(store, run)) return run;
        decisionReady = false;
        if (failureStops()) {
          run.status = "failed";
          await store.save(run);
          await appendEvent(store, id, { type: "run_status", status: run.status });
          return run;
        }
      }
    } finally {
      clearInterval(timer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abort);
      await polling;
    }
  });
}
