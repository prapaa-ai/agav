import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getAgavDir } from "../config/config.js";
import { writeAtomic } from "../background-jobs/storage/atomic-file.js";
import { withJobLock } from "../background-jobs/storage/single-writer-lock.js";
import { validateDefinition, type WorkflowDefinition, type WorkflowNode } from "./definition.js";
import type { ToolRegistry } from "../tools/registry.js";
import { isWorkflowConsent, type WorkflowConsent } from "./grant.js";
import { isDecisionId, type DecidedRecord } from "./decisions.js";

export type NodeStatus = "pending" | "running" | "waiting_approval" | "passed" | "failed" | "cancelled" | "timed_out" | "skipped";
/** Run lifecycle; distinct from NodeStatus (queued/cancelling/interrupted are run-only, skipped is node-only). */
export type RunStatus = "pending" | "queued" | "running" | "passed" | "failed" | "timed_out" | "waiting_approval" | "cancelling" | "cancelled" | "interrupted";
export type RunHost = "background" | "foreground";
/** Durable identity/evidence for a `job` node; requestId is deterministic so a crash before jobId is persisted stays recoverable. */
export interface JobNodeMetadata { requestId: string; jobId?: string; state?: string; exitCode?: number | null; outputTruncated?: boolean }
/** Checkpoint placeholder for an output that exceeded MAX_INLINE_OUTPUT_BYTES; the path is relative to `<root>/<runId>/`. */
export interface ArtifactRef { $artifact: string; bytes: number }
/** `decisionId` links a `waiting_approval` node to its inbox decision; `decision` is the applied result. */
/** Agent/prompt nodes also record the invoker's `usage` (opaque provider data), resolved `model` and `durationMs`. */
export interface NodeCheckpoint { id: string; status: NodeStatus; output?: unknown; error?: string; startedAt?: string; endedAt?: string; job?: JobNodeMetadata; decisionId?: string; decision?: DecidedRecord; usage?: unknown; model?: string; durationMs?: number; /** 1-based attempt of a node with `retry` (job requestIds end in `-<attempt>`). */ attempt?: number }
/** One loop iteration: the body checkpoints keyed by body node id. */
export interface LoopIterationCheckpoint { index: number; status: NodeStatus; nodes: Record<string, NodeCheckpoint>; startedAt?: string; endedAt?: string }
/** Checkpoint of a `loop` node: `iteration` is the current (0-based) iteration; only the last iteration may be non-terminal. */
export type LoopNodeCheckpoint = NodeCheckpoint & { iteration?: number; iterations?: LoopIterationCheckpoint[] };
/**
 * Serialized outputs above this size are written to `<root>/<runId>/artifacts/<nodeId>.json`
 * (loop body nodes: `artifacts/<loopId>.<i>.<nodeId>.json`, nested loops joined with dots).
 */
export const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
export function artifactRelativePath(nodeId: string, scope?: JobScope): string { return `artifacts/${scopePrefix(scope)}${nodeId}.json`; }
/** True for an error recording an unknown outcome (interrupted/unverifiable work); such failures are never tolerated. */
export function isUncertainError(error: string | undefined): boolean {
  return error !== undefined && (error.startsWith("uncertain") || error.startsWith("Interrupted tool had an uncertain outcome"));
}
/**
 * A failed or timed-out node with `continueOnError: true` whose outcome is known: it does not fail its scope and its
 * dependents still run (and can branch on its status with `when`). Uncertain and cancelled outcomes are never tolerated.
 */
export function toleratedFailure(node: WorkflowNode | undefined, cp: NodeCheckpoint): boolean {
  return node?.continueOnError === true && (cp.status === "failed" || cp.status === "timed_out") && !isUncertainError(cp.error);
}
export function isArtifactRef(value: unknown): value is ArtifactRef {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "$artifact");
}
function validArtifactRef(value: unknown, nodeId: string, scope?: JobScope): boolean {
  if (!isArtifactRef(value)) return false;
  const { $artifact, bytes, ...extra } = value as unknown as Record<string, unknown>;
  return Object.keys(extra).length === 0 && $artifact === artifactRelativePath(nodeId, scope) && typeof bytes === "number" && Number.isInteger(bytes) && bytes > 0;
}
/** One checkpoint found by `scopedCheckpoints`, with its definition node and enclosing loops (outermost first). */
export interface CheckpointVisit { cp: NodeCheckpoint; node: WorkflowNode; loops: Array<{ cp: LoopNodeCheckpoint; iteration: LoopIterationCheckpoint }> }
/** Every checkpoint of a run depth-first, including loop nodes and the body checkpoints of each of their iterations. */
export function scopedCheckpoints(run: WorkflowRun): CheckpointVisit[] {
  const out: CheckpointVisit[] = [];
  const walk = (nodes: WorkflowNode[], cps: Record<string, NodeCheckpoint>, loops: CheckpointVisit["loops"]): void => {
    for (const node of nodes) {
      const cp = cps[node.id];
      if (!cp) continue;
      out.push({ cp, node, loops });
      if (node.type !== "loop") continue;
      for (const iteration of (cp as LoopNodeCheckpoint).iterations ?? []) walk(node.body ?? [], iteration.nodes, [...loops, { cp: cp as LoopNodeCheckpoint, iteration }]);
    }
  };
  walk(run.definition.nodes, Object.fromEntries(run.nodes.map(cp => [cp.id, cp])), []);
  return out;
}
/** Job scope (loop path) of a visited checkpoint; undefined at top level. */
export function visitJobScope(visit: CheckpointVisit): JobScope | undefined {
  return visit.loops.length > 0 ? { loopPath: visit.loops.map(loop => ({ loopId: loop.cp.id, iteration: loop.iteration.index })) } : undefined;
}
/** Position of a body node: the enclosing loops (outermost first) and their iteration indexes. */
export interface JobScope { loopPath: Array<{ loopId: string; iteration: number }> }
/** `<loopId>.<i>.` per enclosing loop; artifact file names only (node ids never contain dots). Not valid in job request ids. */
function scopePrefix(scope: JobScope | undefined): string {
  return (scope?.loopPath ?? []).map(({ loopId, iteration }) => {
    if (!Number.isInteger(iteration) || iteration < 0) throw new Error(`Invalid loop iteration: ${iteration}`);
    return `${loopId}.${iteration}.`;
  }).join("");
}
/**
 * `_i<iteration>` per enclosing loop, outermost first. Request ids only allow `[A-Za-z0-9_-]` (background-jobs
 * storage), so no separator character is spare; the loop ids are omitted (node ids are unique across the whole
 * definition, so the node id already determines its loops).
 */
function scopeSuffix(scope: JobScope | undefined): string {
  return (scope?.loopPath ?? []).map(({ iteration }) => {
    if (!Number.isInteger(iteration) || iteration < 0) throw new Error(`Invalid loop iteration: ${iteration}`);
    return `_i${iteration}`;
  }).join("");
}
/**
 * Deterministic, idempotent request id for a job node attempt (`-1` for the first attempt, as in older checkpoints).
 * Body nodes of loops append the iteration index of each enclosing loop: `wf-<runId>-<nodeId>-<attempt>_i<i>[_i<j>]`
 * (e.g. `wf-<uuid>-build-1_i2`). Unambiguous: top-level ids end in `-<digits>`, scoped ones in `_i<digits>`, and the
 * attempt/iterations are parsed from the end (the suffix contains no `-`).
 */
export function jobRequestId(runId: string, nodeId: string, attempt = 1, scope?: JobScope): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Invalid job attempt: ${attempt}`);
  return `wf-${runId}-${nodeId}-${attempt}${scopeSuffix(scope)}`;
}
/** The attempt encoded in a job node's requestId, or undefined when it does not belong to this run/node (and scope). */
export function jobAttempt(requestId: unknown, runId: string, nodeId: string, scope?: JobScope): number | undefined {
  const prefix = `wf-${runId}-${nodeId}-`;
  if (typeof requestId !== "string" || !requestId.startsWith(prefix)) return undefined;
  const suffix = scopeSuffix(scope);
  const rest = requestId.slice(prefix.length);
  if (!rest.endsWith(suffix)) return undefined;
  const attempt = rest.slice(0, rest.length - suffix.length);
  if (!/^[1-9][0-9]{0,5}$/.test(attempt)) return undefined;
  return Number(attempt);
}
const JOB_STATES = new Set(["accepted", "starting", "running", "completed", "failed", "interrupted", "unknown", "recovery-required"]);
/** True for lifecycle states `read` accepts; persisting anything else would make the whole run unreadable. */
export function isPersistableJobState(state: unknown): state is string { return typeof state === "string" && JOB_STATES.has(state); }
function validJobMetadata(job: unknown, runId: string, nodeId: string, scope?: JobScope): boolean {
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  const { requestId, jobId, state, exitCode, outputTruncated, ...extra } = job as Record<string, unknown>;
  return Object.keys(extra).length === 0 && jobAttempt(requestId, runId, nodeId, scope) !== undefined &&
    (jobId === undefined || (typeof jobId === "string" && jobId.length > 0)) &&
    (state === undefined || (typeof state === "string" && JOB_STATES.has(state))) &&
    (exitCode === undefined || exitCode === null || (typeof exitCode === "number" && Number.isInteger(exitCode))) &&
    (outputTruncated === undefined || typeof outputTruncated === "boolean");
}
export interface WorkflowRun {
  version: 1; id: string; definition: WorkflowDefinition; workflowHash: string; cwd: string;
  inputs: Record<string, unknown>; status: RunStatus; nodes: NodeCheckpoint[]; createdAt: string; updatedAt: string;
  host?: RunHost;
  /** Per-invocation background consent; relaunches of this run reuse it. */
  consent?: WorkflowConsent;
  /**
   * Effective `sandboxRequired` of the launching process (flag or config), persisted because the detached runner
   * reloads only disk config. Written only when true and never cleared, so every relaunch keeps enforcing it;
   * absent in older checkpoints (no persisted requirement).
   */
  sandboxRequired?: boolean;
  /** Linkage to the supervised runner job (`requestId = wf-run-<runId>-<attempt>`). */
  runner?: RunnerLink;
  /** Absolute run deadline from `policies.maxRuntimeSeconds`, fixed at the first execution so resume honors it. */
  deadlineAt?: string;
  /** Number of executions (initial run plus resumes) of this run. */
  executionCount?: number;
}
export interface RunnerLink { attempt: number; requestId: string; jobId?: string; relaunches: number }
/** Deterministic, idempotent request id for a run's runner job attempt. */
export function runnerRequestId(runId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Invalid runner attempt: ${attempt}`);
  return `wf-run-${runId}-${attempt}`;
}
function validRunner(runner: unknown, runId: string): boolean {
  if (!runner || typeof runner !== "object" || Array.isArray(runner)) return false;
  const { attempt, requestId, jobId, relaunches, ...extra } = runner as Record<string, unknown>;
  return Object.keys(extra).length === 0 && typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1 && requestId === runnerRequestId(runId, attempt) &&
    (jobId === undefined || (typeof jobId === "string" && jobId.length > 0)) && typeof relaunches === "number" && Number.isInteger(relaunches) && relaunches >= 0;
}
export function assertRunId(id: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid workflow run id (use the full UUID).");
}
export function definitionHash(def: WorkflowDefinition): string { return createHash("sha256").update(JSON.stringify(def)).digest("hex"); }
const NODE_STATUSES = new Set<string>(["pending", "running", "waiting_approval", "passed", "failed", "cancelled", "timed_out", "skipped"]);
const RUN_STATUSES = new Set<string>(["pending", "queued", "running", "passed", "failed", "timed_out", "waiting_approval", "cancelling", "cancelled", "interrupted"]);
async function syncDir(path: string): Promise<void> {
  const dir = await fs.open(path, "r").catch(() => undefined);
  try { await dir?.sync().catch(() => {}); } finally { await dir?.close(); }
}
const TERMINAL_STATUSES = new Set<string>(["passed", "failed", "cancelled", "timed_out", "skipped"]);
const CORRUPT_NODE = "Corrupt workflow checkpoint; invalid node state or dependencies.";
/**
 * Validates the checkpoints of one sibling scope (top level or one loop iteration's body) against its definition
 * nodes, recursing into loop iterations. `cps` is aligned with `nodes`. Returns how many leaf (non-loop) nodes are
 * running, including inside loop bodies; a loop node itself is a container and is not counted.
 */
function validateScopeCheckpoints(run: WorkflowRun, nodes: WorkflowNode[], cps: NodeCheckpoint[], loopPath: JobScope["loopPath"]): number {
  const scope: JobScope | undefined = loopPath.length > 0 ? { loopPath } : undefined;
  const checkpoints = new Map(cps.map(node => [node.id, node]));
  let running = 0;
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const [i, node] of nodes.entries()) {
    const cp = cps[i] as LoopNodeCheckpoint;
    // A tolerated (continueOnError) failure counts as passed for its dependents.
    const deps = (node.dependsOn ?? []).map(dep => { const depCp = checkpoints.get(dep)!; return toleratedFailure(byId.get(dep), depCp) ? "passed" : depCp.status; });
    // Every dispatched/decided node requires passed dependencies (or skipped ones with allowSkipped), including
    // approvals. Check all nodes so a forged passed ancestor cannot unblock work.
    // A skipped node only requires settled dependencies (failed/timed_out ones only under stopOnFailure:false).
    const stopOnFailure = run.definition.policies?.stopOnFailure !== false;
    const skipSettled = (status: NodeStatus): boolean => status === "passed" || status === "skipped" || (!stopOnFailure && (status === "failed" || status === "timed_out" || status === "cancelled"));
    const satisfied = (status: NodeStatus): boolean => status === "passed" || (status === "skipped" && node.allowSkipped === true);
    // A tool node may wait on an inbox decision (tool consent / uncertain outcome), never without one.
    const agentNode = node.type === "agent" || node.type === "prompt";
    if (((node.type === "tool" || agentNode) && cp.status === "waiting_approval" && cp.decisionId === undefined) ||
        (cp.model !== undefined && (!agentNode || typeof cp.model !== "string")) ||
        (cp.durationMs !== undefined && (!agentNode || typeof cp.durationMs !== "number" || !Number.isFinite(cp.durationMs) || cp.durationMs < 0)) ||
        (cp.usage !== undefined && !agentNode) ||
        (cp.decisionId !== undefined && (typeof cp.decisionId !== "string" || !isDecisionId(cp.decisionId))) ||
        // An approval left waiting inside a loop iteration is settled `cancelled` when its run is cancelled.
        (node.type === "approval" && !["pending", "waiting_approval", "passed", "failed", "cancelled"].includes(cp.status)) ||
        (node.type === "job" && cp.status === "waiting_approval") ||
        (cp.job !== undefined && (node.type !== "job" || !validJobMetadata(cp.job, run.id, node.id, scope))) ||
        // A running or passed job must carry its durable identity; fail closed otherwise.
        (node.type === "job" && (cp.status === "running" || cp.status === "passed") && cp.job === undefined) ||
        (cp.attempt !== undefined && (node.retry === undefined || typeof cp.attempt !== "number" || !Number.isInteger(cp.attempt) || cp.attempt < 1 || cp.attempt > node.retry.max + 1)) ||
        // A job's requestId must belong to its recorded attempt, so an old attempt's job is never reattached.
        (cp.job !== undefined && cp.attempt !== undefined && jobAttempt(cp.job.requestId, run.id, node.id, scope) !== cp.attempt) ||
        ((cp.iteration !== undefined || cp.iterations !== undefined) && node.type !== "loop") ||
        (cp.status === "skipped" && !deps.every(skipSettled)) ||
        (cp.status !== "pending" && cp.status !== "skipped" && !deps.every(satisfied))) {
      throw new Error(CORRUPT_NODE);
    }
    if (node.type === "loop") running += validateLoopCheckpoint(run, node, cp, loopPath);
    else if (cp.status === "running") running++;
  }
  return running;
}
/** Loop iterations: indexes 0..n-1 in order, n <= maxIterations, only the last may be non-terminal; bodies recurse. */
function validateLoopCheckpoint(run: WorkflowRun, node: WorkflowNode, cp: LoopNodeCheckpoint, loopPath: JobScope["loopPath"]): number {
  const max = node.maxIterations!;
  const body = node.body!;
  if (cp.iteration !== undefined && (typeof cp.iteration !== "number" || !Number.isInteger(cp.iteration) || cp.iteration < 0 || cp.iteration >= max)) throw new Error(CORRUPT_NODE);
  if (cp.iterations === undefined) return 0;
  const iterations = cp.iterations;
  if (!Array.isArray(iterations) || iterations.length > max || (cp.status === "pending" && iterations.length > 0)) throw new Error(CORRUPT_NODE);
  let running = 0;
  for (const [index, iteration] of iterations.entries()) {
    if (!iteration || typeof iteration !== "object" || Array.isArray(iteration) || iteration.index !== index || !NODE_STATUSES.has(iteration.status) ||
        // Only the last iteration may still be in progress, and never once the loop itself has settled.
        (!TERMINAL_STATUSES.has(iteration.status) && (index !== iterations.length - 1 || TERMINAL_STATUSES.has(cp.status))) ||
        (iteration.startedAt !== undefined && typeof iteration.startedAt !== "string") || (iteration.endedAt !== undefined && typeof iteration.endedAt !== "string") ||
        !iteration.nodes || typeof iteration.nodes !== "object" || Array.isArray(iteration.nodes)) throw new Error(CORRUPT_NODE);
    // Every body node has exactly one checkpoint per iteration, keyed by its id.
    const keys = Object.keys(iteration.nodes);
    if (keys.length !== body.length || body.some(child => !Object.hasOwn(iteration.nodes, child.id))) throw new Error(CORRUPT_NODE);
    const cps = body.map(child => iteration.nodes[child.id]!);
    const childScope: JobScope = { loopPath: [...loopPath, { loopId: node.id, iteration: index }] };
    if (cps.some((child, j) => !child || typeof child !== "object" || child.id !== body[j]!.id || !NODE_STATUSES.has(child.status) || (isArtifactRef(child.output) && !validArtifactRef(child.output, child.id, childScope))) ||
        // A settled iteration has no work left in progress.
        (TERMINAL_STATUSES.has(iteration.status) && cps.some(child => child.status === "running" || child.status === "waiting_approval"))) throw new Error(CORRUPT_NODE);
    running += validateScopeCheckpoints(run, body, cps, childScope.loopPath);
  }
  return running;
}
export class WorkflowStore {
  /** Last output value spilled per `<runId>/<artifact path>`, so unchanged artifacts are not rewritten on every save. */
  private readonly spilled = new Map<string, unknown>();
  constructor(readonly root = join(getAgavDir(), "workflow-runs")) {}
  private path(id: string, suffix = ".json"): string { assertRunId(id); return join(this.root, `${id}${suffix}`); }
  /** Per-run directory (`<root>/<runId>/`) holding artifacts. */
  runDir(id: string): string { assertRunId(id); return join(this.root, id); }
  async save(run: WorkflowRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    // Oversized outputs go to artifacts first; the in-memory run keeps the full value.
    const nodes = await Promise.all(run.nodes.map((cp, i) => this.spillTree(run.id, run.definition.nodes[i], cp, [])));
    await writeAtomic(this.path(run.id), JSON.stringify({ ...run, nodes }, null, 2) + "\n");
    await syncDir(this.root);
  }
  /** `spill` for a checkpoint and, for a loop, the body checkpoints of every iteration (scoped artifact names). */
  private async spillTree(runId: string, node: WorkflowNode | undefined, cp: NodeCheckpoint, loopPath: JobScope["loopPath"]): Promise<NodeCheckpoint> {
    const own = await this.spill(runId, cp, loopPath.length > 0 ? { loopPath } : undefined);
    const iterations = (cp as LoopNodeCheckpoint).iterations;
    if (node?.type !== "loop" || !Array.isArray(iterations)) return own;
    const spilledIterations = await Promise.all(iterations.map(async it => {
      if (!it || typeof it !== "object" || !it.nodes || typeof it.nodes !== "object") return it;
      const path = [...loopPath, { loopId: node.id, iteration: it.index }];
      const entries = await Promise.all(Object.entries(it.nodes).map(async ([key, child]) => [key, await this.spillTree(runId, node.body?.find(b => b.id === key), child, path)] as const));
      return { ...it, nodes: Object.fromEntries(entries) };
    }));
    return { ...own, iterations: spilledIterations } as LoopNodeCheckpoint;
  }
  private async spill(runId: string, cp: NodeCheckpoint, scope?: JobScope): Promise<NodeCheckpoint> {
    // An existing (unhydrated) reference passes through unchanged.
    if (cp.output === undefined || validArtifactRef(cp.output, cp.id, scope)) return cp;
    const serialized = JSON.stringify(cp.output);
    if (serialized === undefined) return cp;
    const bytes = Buffer.byteLength(serialized, "utf8");
    // Any other value shaped like a reference is spilled too, so a persisted `$artifact` object is always a real reference.
    if (bytes <= MAX_INLINE_OUTPUT_BYTES && !isArtifactRef(cp.output)) return cp;
    const relative = artifactRelativePath(cp.id, scope);
    const key = `${runId}/${relative}`;
    if (this.spilled.get(key) !== cp.output) {
      const target = join(this.runDir(runId), relative);
      await writeAtomic(target, serialized); // Durable before the checkpoint references it.
      await syncDir(join(this.runDir(runId), "artifacts"));
      this.spilled.set(key, cp.output);
    }
    return { ...cp, output: { $artifact: relative, bytes } satisfies ArtifactRef };
  }
  /** Resolves a checkpoint output, loading an artifact reference from disk; missing or corrupt artifacts throw. */
  async readOutput(id: string, cp: NodeCheckpoint, scope?: JobScope): Promise<unknown> {
    if (!isArtifactRef(cp.output)) return cp.output;
    if (!validArtifactRef(cp.output, cp.id, scope)) throw new Error(`Corrupt workflow checkpoint; invalid artifact reference for node ${cp.id}.`);
    const text = await fs.readFile(join(this.runDir(id), cp.output.$artifact), "utf8");
    if (Buffer.byteLength(text, "utf8") !== cp.output.bytes) throw new Error(`Corrupt workflow artifact for node ${cp.id}; size mismatch.`);
    const value = JSON.parse(text) as unknown;
    this.spilled.set(`${id}/${cp.output.$artifact}`, value);
    return value;
  }
  /** Replaces artifact references in `run` (including loop body checkpoints) with their stored values (executors need real outputs). */
  async hydrateOutputs(run: WorkflowRun): Promise<void> {
    for (const visit of scopedCheckpoints(run)) if (isArtifactRef(visit.cp.output)) visit.cp.output = await this.readOutput(run.id, visit.cp, visitJobScope(visit));
  }
  async read(id: string, registry: ToolRegistry): Promise<WorkflowRun> {
    // Corruption/I/O failures propagate; never treat them as a fresh run.
    const run = JSON.parse(await fs.readFile(this.path(id), "utf8")) as WorkflowRun;
    if (!run || run.version !== 1 || run.id !== id || typeof run.cwd !== "string" || !run.inputs || typeof run.inputs !== "object" || Array.isArray(run.inputs) ||
        (run.host !== undefined && run.host !== "background" && run.host !== "foreground")) throw new Error("Invalid workflow checkpoint.");
    validateDefinition(run.definition, registry);
    // Consent must be bound to this exact definition and cwd; a mismatched record never authorizes anything.
    if ((run.consent !== undefined && (!isWorkflowConsent(run.consent) || run.consent.definitionHash !== run.workflowHash || run.consent.cwd !== run.cwd)) ||
        (run.runner !== undefined && !validRunner(run.runner, run.id)) ||
        (run.sandboxRequired !== undefined && typeof run.sandboxRequired !== "boolean") ||
        (run.deadlineAt !== undefined && (typeof run.deadlineAt !== "string" || Number.isNaN(Date.parse(run.deadlineAt)) || run.definition.policies?.maxRuntimeSeconds === undefined))) throw new Error("Invalid workflow checkpoint.");
    if (run.workflowHash !== definitionHash(run.definition) || !RUN_STATUSES.has(run.status) || !Array.isArray(run.nodes) || run.nodes.length !== run.definition.nodes.length || run.nodes.some((node, i) => !node || node.id !== run.definition.nodes[i]!.id || !NODE_STATUSES.has(node.status) || (isArtifactRef(node.output) && !validArtifactRef(node.output, node.id)))) throw new Error("Corrupt workflow checkpoint; refusing execution.");
    if (run.executionCount !== undefined && (typeof run.executionCount !== "number" || !Number.isInteger(run.executionCount) || run.executionCount < 0)) throw new Error("Invalid workflow checkpoint.");
    const running = validateScopeCheckpoints(run, run.definition.nodes, run.nodes, []);
    // Keep node-before-run crash snapshots valid (e.g. a decided approval while
    // the run still says waiting_approval), but reject impossible settled states.
    if (running > 1 ||
        (run.status === "pending" && run.nodes.some(node => node.status !== "pending")) ||
        (run.status === "passed" && run.nodes.some((node, i) => node.status !== "passed" && node.status !== "skipped" && !toleratedFailure(run.definition.nodes[i], node)))) {
      throw new Error("Corrupt workflow checkpoint; invalid run state.");
    }
    return run;
  }
  /** Ids of every run checkpoint in the store (unordered); a missing root means no runs. */
  async listIds(): Promise<string[]> {
    let names: string[];
    try { names = await fs.readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names.filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).filter(id => { try { assertRunId(id); return true; } catch { return false; } });
  }
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    assertRunId(id);
    await fs.mkdir(join(this.root, "locks"), { recursive: true, mode: 0o700 });
    return withJobLock(this.root, id, fn);
  }
  async requestCancel(id: string): Promise<void> { await writeAtomic(this.path(id, ".cancel"), "cancel\n"); }
  async cancellationRequested(id: string): Promise<boolean> {
    try { await fs.access(this.path(id, ".cancel")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
}
