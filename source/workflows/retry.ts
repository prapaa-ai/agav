import type { WorkflowNodeDefinition, WorkflowNodeRun, WorkflowRetryPolicy } from "./types.js";

export type RetryDecision =
  | { action: "execute" }
  | { action: "wait_approval"; reason: string }
  | { action: "exhausted"; reason: string }
  | { action: "reuse"; reason: string };

export interface RetryContext {
  node: WorkflowNodeDefinition;
  attempt: number;
  previous: WorkflowNodeRun | null;
  approveRetry: boolean;
  dryRun: boolean;
}

const RETRYABLE_NODE_TYPES = new Set(["agent", "tool", "prompt", "reduce", "skill", "test"]);

export function resolveRetryDecision(ctx: RetryContext): RetryDecision {
  const { node, attempt, previous, approveRetry, dryRun } = ctx;
  const policy = node.retryPolicy ?? {};

  // A prior approval checkpoint for this retry only needs an explicit approval
  // before it can proceed.
  if (previous?.status === "waiting_approval" && previous.output === "retry_approval_required") {
    return approveRetry
      ? { action: "execute" }
      : { action: "wait_approval", reason: "Retry is waiting for explicit approval" };
  }

  // Approval nodes are governed by the approval flow, not the retry policy.
  // A real approval node that is still waiting must be re-evaluated so it can
  // surface the pending decision.
  if (node.type === "approval") return { action: "execute" };

  // Nothing to do on a first attempt.
  if (!previous) return { action: "execute" };

  // `pending` is an explicit operator reset (retry/rewind). It always runs,
  // regardless of the automatic retry budget.
  if (previous.status === "pending") return { action: "execute" };

  // A completed node is never re-run by the retry policy.
  if (previous.status === "passed" || previous.status === "skipped") {
    return { action: "reuse", reason: `Node already ${previous.status}` };
  }

  const maxAttempts = effectiveMaxAttempts(node, policy);

  // Crash recovery: the previous attempt was interrupted mid-flight. This has
  // its own budget so an interrupted node stays resumable even when failure
  // retries are disabled.
  if (previous.status === "running") {
    const crashAttempts = effectiveCrashAttempts(node, policy);
    if (attempt > crashAttempts) {
      return { action: "exhausted", reason: `Node exceeded crash recovery attempts (${crashAttempts})` };
    }
    if (requiresApprovalForRunning(node, policy)) {
      return approveRetry
        ? { action: "execute" }
        : { action: "wait_approval", reason: `Interrupted ${node.type} node requires approval before retry` };
    }
    return { action: "execute" };
  }

  // Interrupted by shutdown rather than failed on its own merits: re-run
  // independent of retry policy and attempt budget, unless the policy
  // explicitly opts the status out.
  if (previous.status === "cancelled") {
    if (policy.nonRetryableStatuses?.includes(previous.status)) {
      return { action: "exhausted", reason: `Status ${previous.status} is not retryable` };
    }
    return { action: "execute" };
  }

  // Regular failure / timeout.
  if (previous.status !== "failed" && previous.status !== "timed_out") {
    return { action: "reuse", reason: `Node is ${previous.status}` };
  }

  // Retries disabled: this is not a budget error, the node simply stands as-is.
  if (!isRetryableFailure(node, policy, previous, dryRun)) {
    return { action: "reuse", reason: `Retries are not enabled for ${node.type} node ${node.id}` };
  }

  if (policy.nonRetryableStatuses?.includes(previous.status)) {
    return { action: "exhausted", reason: `Status ${previous.status} is not retryable` };
  }

  if (attempt > maxAttempts) {
    return { action: "exhausted", reason: `Node exceeded maxAttempts (${maxAttempts})` };
  }

  return { action: "execute" };
}

export function effectiveMaxAttempts(node: WorkflowNodeDefinition, policy: WorkflowRetryPolicy = {}): number {
  if (node.retryPolicy?.maxAttempts !== undefined) return Math.max(1, node.retryPolicy.maxAttempts);
  if (policy.maxAttempts !== undefined) return Math.max(1, policy.maxAttempts);
  return 1;
}

/**
 * Attempts allowed for recovering a node interrupted mid-flight. Defaults to
 * one extra attempt so work in progress when the process died can finish on
 * resume, independent of the failure-retry budget.
 */
export function effectiveCrashAttempts(node: WorkflowNodeDefinition, policy: WorkflowRetryPolicy = {}): number {
  const explicit = node.retryPolicy?.maxAttempts ?? policy.maxAttempts;
  if (explicit !== undefined) return Math.max(1, explicit);
  return DEFAULT_CRASH_ATTEMPTS;
}

export function backoffDelayMs(policy: WorkflowRetryPolicy | undefined, attempt: number): number {
  if (!policy) return 0;
  const initial = policy.initialDelayMs ?? 0;
  if (initial <= 0) return 0;
  const multiplier = policy.backoffMultiplier ?? 2;
  const cap = policy.maxDelayMs ?? 60_000;
  const exponent = Math.max(0, attempt - 1);
  const raw = initial * Math.pow(multiplier, exponent);
  return Math.min(cap, Math.round(raw));
}

export function shouldRetryNode(node: WorkflowNodeDefinition, runMaxAttempts?: number): boolean {
  if (node.retryPolicy?.retryOnFailure) return true;
  if (node.retryPolicy?.maxAttempts !== undefined && node.retryPolicy.maxAttempts > 1) return true;
  return false;
}

function isRetryableFailure(
  node: WorkflowNodeDefinition,
  policy: WorkflowRetryPolicy,
  previous: WorkflowNodeRun,
  dryRun: boolean,
): boolean {
  if (dryRun) return false;
  if (node.retryPolicy?.retryOnFailure === false) return false;
  if (policy.retryOnFailure === true) return true;
  // Retry-on-error is opt-in. Node type alone must not trigger automatic
  // re-execution of a failed external call.
  if (node.retryPolicy?.retryOnFailure === true) return true;
  if (node.retrySafe === true) return false;
  return false;
}

function requiresApprovalForRunning(node: WorkflowNodeDefinition, policy: WorkflowRetryPolicy): boolean {
  if (node.retrySafe === true) return false;
  if (policy.retryRunningAfterCrash === true) return false;
  if (policy.retryRunningAfterCrash === false) return true;
  if (policy.requireApprovalBeforeRetry === true) return true;
  return node.type === "agent" || node.type === "tool";
}

const DEFAULT_CRASH_ATTEMPTS = 2;
