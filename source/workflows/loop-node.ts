import type { WorkflowNode } from "./definition.js";
import { decide, readDecision } from "./decisions.js";
import { appendEvent } from "./events.js";
import { evaluateCondition } from "./expr.js";
import { getNodeExecutor, retriesOnResume, type NodeExecutionContext, type NodeExecutor, type NodeResult } from "./executors.js";
import type { TemplateContext } from "./interpolate.js";
import { applyJobOutcome, JobCancellationIncompleteError, stopJobNodeOutcome, type JobNodeDeps } from "./job-node.js";
import { jobRequestId, MAX_INLINE_OUTPUT_BYTES, scopedCheckpoints, toleratedFailure, visitJobScope, type CheckpointVisit, type LoopIterationCheckpoint, type LoopNodeCheckpoint, type NodeCheckpoint, type NodeStatus, type WorkflowRun, type WorkflowStore } from "./store.js";

const DEFAULT_HISTORY_LIMIT = 5;
const TERMINAL = new Set<NodeStatus>(["passed", "failed", "cancelled", "timed_out", "skipped"]);

const outputsOf = (it: LoopIterationCheckpoint): Record<string, unknown> => Object.fromEntries(Object.values(it.nodes).map(cp => [cp.id, cp.output]));

/** A history output capped at MAX_INLINE_OUTPUT_BYTES: larger values become a truncated JSON text with a size note. */
export function capHistoryOutput(output: unknown): unknown {
  const text = output === undefined ? undefined : JSON.stringify(output);
  if (text === undefined || Buffer.byteLength(text, "utf8") <= MAX_INLINE_OUTPUT_BYTES) return output;
  const bytes = Buffer.byteLength(text, "utf8");
  // Slice by bytes and drop a split trailing multi-byte character.
  const head = Buffer.from(text, "utf8").subarray(0, MAX_INLINE_OUTPUT_BYTES).toString("utf8").replace(/\uFFFD$/, "");
  return `${head}… (truncated; ${bytes} bytes)`;
}

/** `loop.*` for iteration `i`: its index, the previous iteration's body view, and the last `historyLimit` finished iterations. */
export function loopContext(node: WorkflowNode, iterations: LoopIterationCheckpoint[], i: number): NonNullable<TemplateContext["loop"]> {
  const prevIt = i > 0 ? iterations[i - 1] : undefined;
  const limit = node.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const finished = iterations.slice(0, i).filter(it => TERMINAL.has(it.status));
  // Each history output is capped so `limit` large iterations cannot blow up the interpolation context.
  const history = limit > 0 ? finished.slice(-limit).map(it => ({ index: it.index, status: it.status, outputs: Object.fromEntries(Object.entries(outputsOf(it)).map(([id, out]) => [id, capHistoryOutput(out)])) })) : [];
  return {
    index: i, history,
    ...(prevIt ? { prev: Object.fromEntries(Object.values(prevIt.nodes).map(cp => [cp.id, { status: cp.status, output: cp.output }])) } : {}),
  };
}

/**
 * On resume of a running iteration, normalizes interrupted body work like `executeRun` does at the top level:
 * a running job is reattached through the single resume slot (it owns a workload only a reattach can observe or stop), running
 * nested loops stay running for the scheduler to re-enter (the loop takes the slot only when no job is running), a retry-safe
 * agent/prompt is re-dispatched, and any other interrupted node (tool, retrySafe:false agent) is failed closed, never replayed.
 */
function normalizeResumedBody(body: WorkflowNode[], cps: Record<string, NodeCheckpoint>): NodeCheckpoint | undefined {
  // The slot goes to the first running job, whatever its position relative to running nested loops: the scheduler re-enters
  // a running loop by itself, but nothing re-enters a running job, so a loop holding the slot would fail it as uncertain.
  let resume = body.map(child => ({ child, cp: cps[child.id]! })).find(({ child, cp }) => cp.status === "running" && child.type !== "loop" && getNodeExecutor(child.type).resumable === true)?.cp;
  for (const child of body) {
    const cp = cps[child.id]!;
    if (cp.status !== "running" || cp === resume) continue;
    if (child.type === "loop") {
      // Only the loop's own iteration continues; with no job running the first one is the reattach target.
      resume ??= cp;
      continue;
    }
    if (retriesOnResume(child)) {
      cp.status = "pending";
      for (const key of ["output", "error", "startedAt", "endedAt", "usage", "model", "durationMs"] as const) delete cp[key];
      continue;
    }
    cp.status = "failed"; cp.endedAt = new Date().toISOString();
    cp.error = `uncertain: interrupted ${child.tool ?? child.type} node ${child.id} inside a loop has an unknown outcome; not replayed.`;
  }
  return resume;
}

/** Decision ids of body checkpoints parked on a decision, in the iterations `settleParkedBody` would terminalize. */
function parkedDecisionIds(nodes: Record<string, NodeCheckpoint>): string[] {
  const ids: string[] = [];
  for (const cp of Object.values(nodes)) {
    for (const it of (cp as LoopNodeCheckpoint).iterations ?? []) if (!TERMINAL.has(it.status)) ids.push(...parkedDecisionIds(it.nodes));
    if (cp.status === "waiting_approval" && cp.decisionId) ids.push(cp.decisionId);
  }
  return ids;
}

/**
 * Settles body work parked on a decision (approvals, tool consent, nested loops waiting inside the body) once its
 * iteration reached a terminal state for another reason (an independent node failed or was cancelled): nobody can
 * decide it any more, and a terminal iteration may not hold a `waiting_approval` checkpoint (`store.read` rejects it).
 * Only the decisions of the settled checkpoints are durably denied (so `listPendingDecisions` stops surfacing them);
 * decisions of still-live parked work are untouched. The inbox writes come first: if one fails this throws before any
 * checkpoint is mutated, so the checkpoint stays readable and the decisions stay retryable.
 */
export async function settleParkedBody(store: WorkflowStore, runId: string, nodes: Record<string, NodeCheckpoint>, now: string): Promise<void> {
  for (const decisionId of parkedDecisionIds(nodes)) {
    // A missing record (crash between writes, older checkpoints) has nothing to settle; an already decided one stays as decided.
    if (!(await readDecision(store, runId, decisionId))) continue;
    await decide(store, runId, decisionId, false, "workflow-runtime", "Settled: the enclosing scope ended before this was decided.");
  }
  applyParkedSettlement(nodes, now);
}

/**
 * Stops the jobs still running in `visits` (confirmed, fail closed): the real outcome, or the kept linkage and reason,
 * is saved first and an unconfirmed stop throws `JobCancellationIncompleteError`, so the scope is never terminalized
 * with a live workload behind it. Without job support nothing is claimed stopped.
 */
export async function stopLiveJobs(store: WorkflowStore, run: WorkflowRun, jobDeps: JobNodeDeps | undefined, visits: CheckpointVisit[]): Promise<void> {
  for (const visit of visits.filter(v => v.cp.status === "running" && v.node.type === "job")) {
    const { cp } = visit;
    const requestId = cp.job?.requestId ?? jobRequestId(run.id, cp.id, cp.attempt ?? 1, visitJobScope(visit));
    if (!jobDeps) throw new Error(`Job nodes unavailable: node ${cp.id} has a running job (${requestId}) and this run is ending; resume with background-job support to stop it.`);
    const outcome = await stopJobNodeOutcome(jobDeps, { requestId, jobId: cp.job?.jobId });
    applyJobOutcome(cp, outcome);
    await store.save(run); // The real outcome (or the kept linkage/reason) is durable first.
    if (outcome.status === "incomplete") throw new JobCancellationIncompleteError(cp.id, outcome.error ?? "termination not confirmed");
  }
}

/**
 * Settles the running or parked loops among `visits` (innermost first, as `scopedCheckpoints` is depth-first): the
 * current iteration has no work left in progress. Only the given loops are touched, never their enclosing ones.
 */
export async function settleLoopVisits(store: WorkflowStore, run: WorkflowRun, visits: CheckpointVisit[], now: string): Promise<void> {
  for (const visit of [...visits].reverse()) {
    const loop = visit.cp as LoopNodeCheckpoint;
    if (visit.node.type !== "loop" || (loop.status !== "running" && loop.status !== "waiting_approval")) continue;
    const current = loop.iterations?.[loop.iterations.length - 1];
    if (current && !TERMINAL.has(current.status)) {
      await settleParkedBody(store, run.id, current.nodes, now);
      const failed = visit.node.body?.some(n => { const c = current.nodes[n.id]!; return (c.status === "failed" || c.status === "timed_out") && !toleratedFailure(n, c); });
      current.status = failed ? "failed" : "cancelled"; current.endedAt = now;
    }
    loop.status = current?.status === "failed" ? "failed" : "cancelled"; loop.endedAt = now;
    if (loop.status === "failed") loop.error = `iteration ${current!.index} failed`;
  }
}

/**
 * Before an iteration turns terminal for a reason other than parking: stops the live jobs and settles the nested loops
 * still running inside it (a sibling nested loop the scheduler never re-entered, e.g. after an earlier sibling failed
 * under stopOnFailure). Scoped to the iteration's own subtree: the current (outer) loop is left to its executor.
 */
async function settleIterationSubtree(store: WorkflowStore, run: WorkflowRun, jobDeps: JobNodeDeps | undefined, it: LoopIterationCheckpoint): Promise<void> {
  const inside = scopedCheckpoints(run).filter(visit => visit.loops.some(entry => entry.iteration === it));
  if (!inside.some(visit => visit.cp.status === "running" || visit.cp.status === "waiting_approval")) return;
  await stopLiveJobs(store, run, jobDeps, inside);
  await settleLoopVisits(store, run, inside, new Date().toISOString());
}

function applyParkedSettlement(nodes: Record<string, NodeCheckpoint>, now: string): void {
  for (const cp of Object.values(nodes)) {
    const loop = cp as LoopNodeCheckpoint;
    if (loop.iterations) {
      for (const it of loop.iterations) {
        if (TERMINAL.has(it.status)) continue;
        applyParkedSettlement(it.nodes, now);
        it.status = "cancelled"; it.endedAt = now;
      }
    }
    if (cp.status !== "waiting_approval") continue;
    cp.status = "cancelled"; cp.endedAt = now; cp.error = "Cancelled while waiting for a decision.";
    delete cp.decisionId;
  }
}

/**
 * Sequential loop: runs `body` as a nested scope once per iteration (checkpointed in `iterations[i].nodes`) until
 * `stopWhen`/`until` holds after a passed iteration, a body failure, or `maxIterations` (then `onExhausted`).
 * An iteration whose only failures are tolerated (`continueOnError`) body nodes counts as passed, so
 * `stopWhen`/`until` still see the failed statuses (e.g. "run tests, fix, repeat until tests pass").
 * A waiting/cancelled iteration propagates and is continued on resume. `timeoutSeconds` bounds the whole loop,
 * measured from the loop's first start.
 */
async function executeLoop(ctx: NodeExecutionContext): Promise<NodeResult> {
  const { store, run, node, signal } = ctx;
  const cp = ctx.checkpoint as LoopNodeCheckpoint;
  const body = node.body!;
  const max = node.maxIterations!;
  const save = (): Promise<void> => store.save(run);
  const settle = async (status: NodeStatus, extra: { output?: unknown; error?: string } = {}): Promise<NodeResult> => {
    cp.status = status;
    if (extra.output !== undefined) cp.output = extra.output;
    if (extra.error !== undefined) cp.error = extra.error;
    if (TERMINAL.has(status)) cp.endedAt = new Date().toISOString();
    await save();
    return { next: status === "passed" || status === "waiting_approval" ? "continue" : "stop" };
  };
  if (!ctx.runSubScope) return settle("failed", { error: "loop execution unavailable in this context" });

  if (cp.status !== "running") { cp.status = "running"; delete cp.error; delete cp.output; delete cp.endedAt; }
  cp.startedAt ??= new Date().toISOString();
  cp.iterations ??= [];
  await save();

  const child = new AbortController();
  const abortChild = (): void => { child.abort(); };
  signal.addEventListener("abort", abortChild, { once: true });
  if (signal.aborted) abortChild();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (node.timeoutSeconds !== undefined) {
    const started = Date.parse(cp.startedAt);
    const remaining = (Number.isNaN(started) ? Date.now() : started) + node.timeoutSeconds * 1000 - Date.now();
    const fire = (): void => { if (!signal.aborted) { timedOut = true; child.abort(); } };
    if (remaining <= 0) fire(); else timer = setTimeout(fire, remaining);
  }
  const timeoutError = `Loop timed out after ${node.timeoutSeconds}s.`;
  try {
    for (let i = cp.iteration ?? 0; i < max; i++) {
      let it = cp.iterations[i];
      if (!it) {
        it = { index: i, status: "running", nodes: Object.fromEntries(body.map(n => [n.id, { id: n.id, status: "pending" as const }])), startedAt: new Date().toISOString() };
        cp.iterations[i] = it;
        cp.iteration = i;
        await save();
        await appendEvent(store, run.id, { type: "loop_iteration_started", nodeId: node.id, iteration: i });
      }
      const loop = loopContext(node, cp.iterations, i);
      if (!TERMINAL.has(it.status)) {
        // Re-entered iteration (resume, or re-dispatch after waiting): continue it in place. Interrupted body work is
        // normalized on every re-entry, not only for the loop `env.resume` selected: with several running root loops
        // only one is the resume target, and a running child left unnormalized in the others would be stranded.
        const resume = normalizeResumedBody(body, it.nodes);
        it.status = "running";
        await save();
        const status = await ctx.runSubScope({
          nodes: body, checkpoints: it.nodes, loop,
          jobScope: { loopPath: [...(ctx.jobScope?.loopPath ?? []), { loopId: node.id, iteration: i }] },
          outerNodes: { ...(ctx.scopeNodes ?? Object.fromEntries(run.nodes.map(n => [n.id, n]))) },
        }, { signal: child.signal, ...(resume ? { resume } : {}) });
        if (status === "waiting_approval") { it.status = "waiting_approval"; return await settle("waiting_approval"); }
        // Live jobs are stopped (confirmed) and unvisited nested loops settled first: an unconfirmed stop throws here, leaving
        // the iteration, its loop and the job linkage non-terminal and readable.
        await settleIterationSubtree(store, run, ctx.jobDeps, it);
        // Inbox decisions are settled before the iteration turns terminal; a failed write leaves it non-terminal and readable.
        await settleParkedBody(store, run.id, it.nodes, new Date().toISOString());
        it.status = timedOut && (status === "cancelled" || status === "timed_out") ? "timed_out" : status;
        it.endedAt = new Date().toISOString();
        await save();
        await appendEvent(store, run.id, { type: "loop_iteration_completed", nodeId: node.id, iteration: i, status: it.status });
      }
      if (it.status === "cancelled") return await settle("cancelled", { error: `iteration ${i} cancelled` });
      if (it.status !== "passed") {
        const failed = body.find(n => { const c = it!.nodes[n.id]!; return (c.status === "failed" || c.status === "timed_out") && !toleratedFailure(n, c); });
        const failedCp = failed ? it.nodes[failed.id] : undefined;
        const error = it.status === "timed_out" && timedOut ? timeoutError : `iteration ${i} ${it.status}${failedCp ? `: ${failedCp.id}: ${failedCp.error ?? failedCp.status}` : ""}`;
        return await settle(it.status === "timed_out" ? "timed_out" : "failed", { error });
      }
      let stop: boolean;
      try {
        if (node.stopWhen) stop = it.nodes[node.stopWhen.node]?.status === node.stopWhen.status;
        else if (node.until !== undefined) {
          const view = (cps: NodeCheckpoint[]): Array<[string, { status: string; output?: unknown }]> => cps.map(n => [n.id, { status: n.status, output: n.output }]);
          const outer = Object.values(ctx.scopeNodes ?? Object.fromEntries(run.nodes.map(n => [n.id, n])));
          stop = evaluateCondition(node.until, { inputs: run.inputs, nodes: Object.fromEntries([...view(outer), ...view(Object.values(it.nodes))]), loop });
        } else stop = false;
      } catch (error) {
        return await settle("failed", { error: `until could not be evaluated: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (stop) return await settle("passed", { output: outputsOf(it) });
      if (signal.aborted || child.signal.aborted) break;
      if (i + 1 < max) { cp.iteration = i + 1; await save(); }
    }
    if (timedOut) return await settle("timed_out", { error: timeoutError });
    if (signal.aborted) return await settle("cancelled");
    const last = cp.iterations[cp.iterations.length - 1];
    if (node.onExhausted === "continue") return await settle("passed", { output: last ? outputsOf(last) : {} });
    return await settle("failed", { error: `loop exhausted after ${max} iterations` });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abortChild);
  }
}

/** Resumable: a running loop is re-entered on resume and continues its current iteration. */
export const loopExecutor: NodeExecutor = { type: "loop", resumable: true, execute: executeLoop };
