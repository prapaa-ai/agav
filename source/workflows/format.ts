import type { PendingDecision } from "./decisions.js";
import { assertRunId, isArtifactRef, scopedCheckpoints, type LoopNodeCheckpoint, type WorkflowRun, type WorkflowStore } from "./store.js";

/**
 * Human-readable workflow output (U3/U4): status glyphs, short run ids, one-line run summaries, the run tree
 * and inbox decision lines. CLI, slash command and notifications all format through here.
 */

export const TERMINAL_RUN_STATUSES = ["passed", "failed", "cancelled", "timed_out"] as const;
export function isTerminalRunStatus(status: string): boolean { return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status); }

const GLYPHS: Record<string, string> = {
  passed: "✓", failed: "✗", running: "●", cancelling: "●", waiting_approval: "◐", cancelled: "⊘", timed_out: "⏱",
  pending: "…", queued: "…", interrupted: "!", skipped: "↷",
};
/** Glyph for a run or node status (`?` for an unknown status). */
export function statusGlyph(status: string): string { return GLYPHS[status] ?? "?"; }

/** The first 8 characters of a run id (the display form; any unique prefix of ≥4 chars resolves back). */
export function shortId(runId: string): string { return runId.slice(0, 8); }

export const MIN_RUN_ID_PREFIX = 4;
const FULL_RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/**
 * Resolves a git-like run id prefix (≥4 chars) to the full run id. A full UUID is returned as is (no lookup).
 * Throws for a too-short or malformed prefix, no match, or an ambiguous prefix (listing the candidates).
 */
export async function resolveRunId(store: Pick<WorkflowStore, "listIds">, prefix: string): Promise<string> {
  const wanted = prefix.trim().toLowerCase();
  if (FULL_RUN_ID.test(wanted)) { assertRunId(wanted); return wanted; }
  if (wanted.length < MIN_RUN_ID_PREFIX) throw new Error(`Workflow run id prefix "${prefix}" is too short (use at least ${MIN_RUN_ID_PREFIX} characters).`);
  if (!/^[a-f0-9-]+$/.test(wanted)) throw new Error(`Invalid workflow run id "${prefix}".`);
  const matches = (await store.listIds()).filter(id => id.startsWith(wanted)).sort();
  if (matches.length === 0) throw new Error(`No workflow run matches "${prefix}".`);
  if (matches.length > 1) throw new Error(`Ambiguous workflow run id "${prefix}" matches ${matches.length} runs:\n${matches.map(id => `  ${id}`).join("\n")}`);
  return matches[0]!;
}

/** Compact duration: `850ms`, `14.1s`, `3m12s`, `2h05m`, `3d4h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.floor(s), m = Math.floor(total / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (m < 60) return `${m}m${String(total % 60).padStart(2, "0")}s`;
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${d}d${h % 24}h`;
}

/** One line for an output: collapsed whitespace, truncated text or compact JSON (≤ `max` chars). */
export function truncateOutput(output: unknown, max = 160): string {
  if (isArtifactRef(output)) return `(stored in ${output.$artifact}, ${output.bytes} bytes)`;
  return truncate(typeof output === "string" ? output : JSON.stringify(output) ?? String(output), max);
}
function truncate(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `<glyph> <shortId> <workflow> <status> <duration|age>`: duration once terminal, otherwise time since creation. */
export function formatRunSummary(run: WorkflowRun, now = Date.now()): string {
  const created = Date.parse(run.createdAt);
  const time = isTerminalRunStatus(run.status) ? formatDuration(Date.parse(run.updatedAt) - created) : `started ${formatDuration(now - created)} ago`;
  return `${statusGlyph(run.status)} ${shortId(run.id)}  ${run.definition.name}  ${run.status}  ${time}`;
}

/**
 * The run tree: a header, then one line per node with its glyph, attempt n/max, agent model/duration, error and a
 * truncated output. Loop nodes show `loop <id> iteration i/max`, earlier iterations as glyphs and the current/last
 * iteration's body nodes indented below.
 */
export function formatRunTree(run: WorkflowRun): string {
  const deadline = run.deadlineAt && !isTerminalRunStatus(run.status) ? ` (deadline ${run.deadlineAt})` : "";
  const lines = [`Workflow run ${run.id} (${run.definition.name}): ${statusGlyph(run.status)} ${run.status}${deadline}`];
  for (const visit of scopedCheckpoints(run)) {
    const { cp, node } = visit;
    // Only the current/last iteration of each enclosing loop is expanded; earlier ones are summarized on the loop line.
    if (visit.loops.some(({ cp: loop, iteration }) => iteration !== loop.iterations?.at(-1))) continue;
    const indent = "  ".repeat(visit.loops.length * 2 + 1);
    // attempt n/max counts total attempts (the first run plus retry.max retries).
    const attempt = node.retry && cp.attempt !== undefined && (cp.attempt > 1 || cp.status !== "passed") ? ` (attempt ${cp.attempt}/${node.retry.max + 1})` : "";
    const agent = node.type === "agent" || node.type === "prompt";
    const meta = agent && cp.status === "passed" ? [cp.model, cp.durationMs !== undefined ? `${(cp.durationMs / 1000).toFixed(1)}s` : undefined].filter(Boolean).join(", ") : "";
    const error = cp.error ? ` — ${truncate(cp.error)}` : "";
    if (node.type !== "loop") {
      lines.push(`${indent}${statusGlyph(cp.status)} ${cp.id}: ${cp.status}${attempt}${meta ? ` (${meta})` : ""}${error}`);
      if (cp.status === "passed" && cp.output !== undefined && node.type !== "approval") lines.push(`${indent}    → ${truncateOutput(cp.output)}`);
      continue;
    }
    const iterations = (cp as LoopNodeCheckpoint).iterations ?? [];
    const iteration = (cp as LoopNodeCheckpoint).iteration;
    const current = iterations.length || (iteration !== undefined ? iteration + 1 : 0);
    const progress = current > 0 ? ` (loop ${cp.id} iteration ${current}/${node.maxIterations})` : "";
    lines.push(`${indent}${statusGlyph(cp.status)} ${cp.id}: ${cp.status}${progress}${error}`);
    if (iterations.length > 1) lines.push(`${indent}    earlier iterations: ${iterations.slice(0, -1).map(it => statusGlyph(it.status)).join(" ")}`);
    const last = iterations.at(-1);
    if (last) lines.push(`${indent}  ${statusGlyph(last.status)} iteration ${last.index + 1}: ${last.status}`);
  }
  return lines.join("\n");
}

/** One inbox line: `◐ <shortId>  <decisionId>  <kind> <node>[ iteration i] [tool #hash]  <summary>`. */
export function formatDecision(decision: PendingDecision): string {
  const iteration = decision.iteration?.length ? ` (iteration ${decision.iteration.map(i => i + 1).join(".")})` : "";
  const tool = decision.resolved ? ` ${decision.resolved.toolName} #${decision.resolved.inputHash.slice(0, 8)}` : "";
  return `${statusGlyph("waiting_approval")} ${shortId(decision.runId)}  ${decision.decisionId}  ${decision.kind.padEnd(14)} ${decision.nodeId}${iteration}${tool}  ${truncate(decision.summary)}`;
}
