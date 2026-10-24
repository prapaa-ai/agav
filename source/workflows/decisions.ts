import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { createExclusive, readJsonIfExists } from "../background-jobs/storage/atomic-file.js";
import { appendEvent } from "./events.js";
import { scopedCheckpoints, type CheckpointVisit, type NodeCheckpoint, type WorkflowRun, type WorkflowStore } from "./store.js";

/** Leaf checkpoints (loop nodes are containers) at every depth, including loop iteration bodies. */
function leafVisits(run: WorkflowRun): CheckpointVisit[] { return scopedCheckpoints(run).filter(visit => visit.node.type !== "loop"); }
/** Iteration path (outermost loop first) of a visited body checkpoint; undefined at top level. */
function visitIteration(visit: CheckpointVisit): number[] | undefined { return visit.loops.length > 0 ? visit.loops.map(loop => loop.iteration.index) : undefined; }
/** Approval decisions inside loops are keyed per iteration, so one iteration's answer never decides the next. */
export function approvalDiscriminator(iteration?: number[]): string | undefined { return iteration && iteration.length > 0 ? `iteration:${iteration.join(".")}` : undefined; }
/** A body decision changed: the enclosing (parked) iterations and loops resume running so the scheduler re-enters them. */
function rearmLoops(visit: CheckpointVisit): void {
  for (const { cp, iteration } of visit.loops) {
    if (iteration.status === "waiting_approval") iteration.status = "running";
    if (cp.status === "waiting_approval") cp.status = "running";
  }
}

/**
 * Inbox decisions (`<runDir>/decisions/`). The runner writes `<id>.json` (pending); any session decides by
 * creating `<id>.decided.json` with `createExclusive`, so exactly one decider wins and run.json is never
 * touched by a decider (the runner stays its single writer).
 */
export type DecisionKind = "approval" | "tool_consent" | "agent_tool_consent" | "job_start" | "uncertain_tool";
export interface ResolvedInput { toolName: string; input: unknown; inputHash: string }
export interface PendingDecision {
  version: 1;
  decisionId: string;
  runId: string;
  kind: DecisionKind;
  nodeId: string;
  iteration?: number[];
  summary: string;
  resolved?: ResolvedInput;
  createdAt: string;
}
export interface DecidedRecord { decisionId: string; decision: "approve" | "deny"; decidedAt: string; decidedBy: string; note?: string }
export interface DecisionState { pending: PendingDecision; decided?: DecidedRecord }

const DECISION_ID = /^dec_[a-f0-9]{16}$/;
const KINDS = new Set<string>(["approval", "tool_consent", "agent_tool_consent", "job_start", "uncertain_tool"]);

export function isDecisionId(value: string): boolean { return DECISION_ID.test(value); }
function assertDecisionId(id: string): void { if (!DECISION_ID.test(id)) throw new Error(`Invalid workflow decision id: ${id}`); }

/** JSON with object keys sorted recursively, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function inputHash(input: unknown): string { return createHash("sha256").update(canonicalJson(input)).digest("hex"); }
export function resolvedInput(toolName: string, input: unknown): ResolvedInput { return { toolName, input, inputHash: inputHash(input) }; }

/**
 * Deterministic id: the same kind/node/tool/input always maps to the same decision, so identical calls
 * reuse one decision and a changed input gets a new one. `discriminator` separates distinct occurrences
 * that must never share a decision (e.g. two separate interruptions of the same tool node).
 */
export function decisionIdFor(kind: DecisionKind, nodeId: string, resolved?: ResolvedInput, discriminator = ""): string {
  const key = [kind, nodeId, resolved?.toolName ?? "", resolved?.inputHash ?? "", discriminator].join("\0");
  return `dec_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function decisionsDir(store: WorkflowStore, runId: string): string { return join(store.runDir(runId), "decisions"); }
function pendingPath(store: WorkflowStore, runId: string, id: string): string { assertDecisionId(id); return join(decisionsDir(store, runId), `${id}.json`); }
function decidedPath(store: WorkflowStore, runId: string, id: string): string { assertDecisionId(id); return join(decisionsDir(store, runId), `${id}.decided.json`); }

/** `user@host` of the deciding session. */
export function defaultDecider(): string {
  let user = "unknown";
  try { user = userInfo().username || user; } catch { /* no passwd entry */ }
  return `${user}@${hostname()}`;
}

export interface PendingDecisionRequest { kind: DecisionKind; nodeId: string; iteration?: number[]; summary: string; resolved?: ResolvedInput; discriminator?: string }

/** Idempotent: an existing record with the same deterministic id is returned unchanged. */
export async function createPendingDecision(store: WorkflowStore, runId: string, request: PendingDecisionRequest): Promise<PendingDecision> {
  const decisionId = decisionIdFor(request.kind, request.nodeId, request.resolved, request.discriminator);
  const record: PendingDecision = {
    version: 1, decisionId, runId, kind: request.kind, nodeId: request.nodeId,
    ...(request.iteration ? { iteration: request.iteration } : {}),
    summary: request.summary,
    ...(request.resolved ? { resolved: request.resolved } : {}),
    createdAt: new Date().toISOString(),
  };
  const path = pendingPath(store, runId, decisionId);
  if (await createExclusive(path, JSON.stringify(record, null, 2) + "\n")) return record;
  return (await readPending(path, runId, decisionId)) ?? record;
}

async function readPending(path: string, runId: string, id: string): Promise<PendingDecision | undefined> {
  const record = await readJsonIfExists<PendingDecision>(path);
  if (record === undefined) return undefined;
  if (!record || record.decisionId !== id || record.runId !== runId || !KINDS.has(record.kind) || typeof record.nodeId !== "string") throw new Error(`Corrupt workflow decision: ${id}`);
  return record;
}
async function readDecided(path: string, id: string): Promise<DecidedRecord | undefined> {
  const record = await readJsonIfExists<DecidedRecord>(path);
  if (record === undefined) return undefined;
  if (!record || record.decisionId !== id || (record.decision !== "approve" && record.decision !== "deny")) throw new Error(`Corrupt workflow decision result: ${id}`);
  return record;
}

/** The pending request and, once decided, its result; undefined when no such decision exists. */
export async function readDecision(store: WorkflowStore, runId: string, decisionId: string): Promise<DecisionState | undefined> {
  const pending = await readPending(pendingPath(store, runId, decisionId), runId, decisionId);
  if (!pending) return undefined;
  const decided = await readDecided(decidedPath(store, runId, decisionId), decisionId);
  return decided ? { pending, decided } : { pending };
}

/** Every decision of a run (pending and decided), oldest first. */
export async function listDecisions(store: WorkflowStore, runId: string): Promise<DecisionState[]> {
  let names: string[];
  try { names = await fs.readdir(decisionsDir(store, runId)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const states: DecisionState[] = [];
  for (const name of names) {
    const id = name.endsWith(".json") && !name.endsWith(".decided.json") ? name.slice(0, -5) : undefined;
    if (!id || !isDecisionId(id)) continue;
    const state = await readDecision(store, runId, id).catch(() => undefined);
    if (state) states.push(state);
  }
  return states.sort((a, b) => a.pending.createdAt.localeCompare(b.pending.createdAt) || a.pending.decisionId.localeCompare(b.pending.decisionId));
}

/** Undecided requests of one run, or of every run when `runId` is omitted; unreadable runs are skipped. */
export async function listPendingDecisions(store: WorkflowStore, runId?: string): Promise<PendingDecision[]> {
  const ids = runId === undefined ? await store.listIds() : [runId];
  const pending: PendingDecision[] = [];
  for (const id of ids) {
    const states = runId === undefined ? await listDecisions(store, id).catch(() => []) : await listDecisions(store, id);
    for (const state of states) if (!state.decided) pending.push(state.pending);
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.decisionId.localeCompare(b.decisionId));
}

/** Creates the result once; a losing decider gets `won: false` and the record that won. */
export async function decide(store: WorkflowStore, runId: string, decisionId: string, approve: boolean, by: string, note?: string): Promise<{ won: boolean; record: DecidedRecord }> {
  const state = await readDecision(store, runId, decisionId);
  if (!state) throw new Error(`No decision ${decisionId} in workflow run ${runId}.`);
  if (state.decided) return { won: false, record: state.decided };
  const record: DecidedRecord = { decisionId, decision: approve ? "approve" : "deny", decidedAt: new Date().toISOString(), decidedBy: by, ...(note ? { note } : {}) };
  const path = decidedPath(store, runId, decisionId);
  if (await createExclusive(path, JSON.stringify(record, null, 2) + "\n")) return { won: true, record };
  const winner = await readDecided(path, decisionId);
  if (!winner) throw new Error(`Decision ${decisionId} result vanished.`);
  return { won: false, record: winner };
}

/** Parks `cp` on `decision`; the caller persists the run. */
export function parkCheckpoint(cp: NodeCheckpoint, decision: PendingDecision): void {
  cp.status = "waiting_approval";
  cp.decisionId = decision.decisionId;
  delete cp.endedAt;
}

/**
 * Turns every interrupted (running) non-resumable node into an `uncertain_tool` decision; never replays it.
 * Each interruption gets its own decision (keyed by the attempt's `startedAt`), so an approved retry that is
 * interrupted again asks again. The caller persists the run.
 */
export async function parkUncertainNodes(store: WorkflowStore, run: WorkflowRun, isUncertain: (cp: NodeCheckpoint) => boolean): Promise<PendingDecision[]> {
  const parked: PendingDecision[] = [];
  for (const visit of leafVisits(run)) {
    const { cp, node } = visit;
    if (cp.status !== "running" || !isUncertain(cp)) continue;
    const iteration = visitIteration(visit);
    const decision = await createPendingDecision(store, run.id, {
      kind: "uncertain_tool", nodeId: cp.id, discriminator: cp.startedAt ?? run.updatedAt, ...(iteration ? { iteration } : {}),
      summary: `Interrupted ${node.tool ?? node.type} node ${cp.id} has an uncertain outcome; approve to retry, deny to mark it failed.`,
      ...(node.tool ? { resolved: resolvedInput(node.tool, node.input ?? {}) } : {}),
    });
    parkCheckpoint(cp, decision);
    await appendEvent(store, run.id, { type: "decision_requested", nodeId: cp.id, decisionId: decision.decisionId, kind: decision.kind });
    parked.push(decision);
  }
  return parked;
}

/** True when some waiting node's decision has a result the runner has not applied yet. */
export async function hasUnappliedDecision(store: WorkflowStore, run: WorkflowRun): Promise<boolean> {
  for (const { cp } of leafVisits(run)) {
    if (cp.status !== "waiting_approval" || !cp.decisionId) continue;
    if ((await readDecision(store, run.id, cp.decisionId).catch(() => undefined))?.decided) return true;
  }
  return false;
}

/**
 * Runner-side application of decided records to waiting nodes (the runner is run.json's only writer).
 * - approval: approve ⇒ passed (record kept on the checkpoint); deny ⇒ failed.
 * - tool_consent: approve ⇒ pending, re-dispatched (the host reuses the approval for that exact input); deny ⇒ failed.
 * - uncertain_tool: approve ⇒ pending (retry); deny ⇒ failed.
 * A waiting approval without a decision (crash between writes, older checkpoints) gets its decision recreated.
 * Returns true when any checkpoint changed; the caller persists the run.
 */
export async function applyDecisions(store: WorkflowStore, run: WorkflowRun): Promise<boolean> {
  let changed = false;
  for (const visit of leafVisits(run)) {
    const { cp, node } = visit;
    if (cp.status !== "waiting_approval") continue;
    if (!cp.decisionId) {
      if (node.type !== "approval") continue;
      const iteration = visitIteration(visit);
      const discriminator = approvalDiscriminator(iteration);
      const decision = await createPendingDecision(store, run.id, { kind: "approval", nodeId: cp.id, summary: node.prompt ?? `Approve ${cp.id}`, ...(iteration ? { iteration } : {}), ...(discriminator ? { discriminator } : {}) });
      cp.decisionId = decision.decisionId;
      changed = true;
    }
    const state = await readDecision(store, run.id, cp.decisionId);
    if (!state?.decided) continue;
    const { pending, decided } = state;
    const approved = decided.decision === "approve";
    const now = new Date().toISOString();
    if (pending.kind === "approval") {
      cp.status = approved ? "passed" : "failed";
      cp.output = approved ? "approved" : "denied";
      cp.decision = decided;
      if (!approved) cp.error = `Approval denied by ${decided.decidedBy}${decided.note ? `: ${decided.note}` : "."}`;
      cp.endedAt = now;
      delete cp.decisionId;
    } else if (approved) {
      // Re-dispatch the node; it re-resolves its input, and only the exact approved input proceeds.
      cp.status = "pending";
      for (const key of ["decisionId", "decision", "output", "error", "startedAt", "endedAt"] as const) delete cp[key];
    } else {
      cp.status = "failed";
      cp.decision = decided;
      cp.error = pending.kind === "uncertain_tool"
        ? `Interrupted tool had an uncertain outcome; marked failed by ${decided.decidedBy}${decided.note ? `: ${decided.note}` : "."}`
        : `Tool '${pending.resolved?.toolName ?? node.tool}' permission denied by ${decided.decidedBy}${decided.note ? `: ${decided.note}` : "."}`;
      cp.endedAt = now;
      delete cp.decisionId;
    }
    rearmLoops(visit);
    changed = true;
    await appendEvent(store, run.id, { type: "decision_applied", nodeId: cp.id, decisionId: pending.decisionId, decision: decided.decision, decidedBy: decided.decidedBy });
  }
  return changed;
}

/** Thrown by a host to park the current node on a pending decision instead of failing it. */
export class DecisionPendingError extends Error {
  constructor(readonly decision: PendingDecision) {
    super(`Waiting for decision ${decision.decisionId} (${decision.kind} on node ${decision.nodeId}).`);
    this.name = "DecisionPendingError";
  }
}

/**
 * Polls until `decisionId` is decided (true = approve) or `signal` aborts (false). Used by agent nodes, whose
 * sub-tool consent cannot park the node mid-conversation: the agent waits in-process for the inbox decision.
 */
export async function waitForDecision(store: WorkflowStore, runId: string, decisionId: string, signal: AbortSignal, intervalMs = 200): Promise<boolean> {
  for (;;) {
    if (signal.aborted) return false;
    const state = await readDecision(store, runId, decisionId);
    if (state?.decided) return state.decided.decision === "approve";
    await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
