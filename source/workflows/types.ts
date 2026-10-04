import type { EffortLevel, PermissionMode } from "../config/config.js";

export type WorkflowNodeType =
  | "agent"
  | "tool"
  | "test"
  | "approval"
  | "prompt"
  | "skill"
  | "parallel"
  | "reduce"
  | "loop";

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "waiting_approval"
  | "passed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "passed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "timed_out";

export interface WorkflowPolicies {
  maxRuntimeSeconds?: number;
  maxNodeRuntimeSeconds?: number;
  maxIterations?: number;
  maxConcurrency?: number;
  permissionMode?: PermissionMode;
  sandbox?: "auto" | "seatbelt" | "bubblewrap" | "docker" | "none";
  stopOnFailure?: boolean;
  resume?: boolean;
  tokenBudget?: number;
  costBudgetUsd?: number;
}

export interface WorkflowRetryPolicy {
  /** Total attempts allowed, including the first. Default 1 (no retry). */
  maxAttempts?: number;
  /** Whether an interrupted (`running`) node may be retried automatically after a crash. */
  retryRunningAfterCrash?: boolean;
  /** Requires explicit approval before retrying an interrupted node. */
  requireApprovalBeforeRetry?: boolean;
  /** Whether a node that returned an error may be retried automatically. */
  retryOnFailure?: boolean;
  /** Initial backoff delay in milliseconds before the first retry. */
  initialDelayMs?: number;
  /** Backoff growth factor applied per attempt. Default 2. */
  backoffMultiplier?: number;
  /** Upper bound for a single backoff delay in milliseconds. */
  maxDelayMs?: number;
  /** Node statuses that should not be retried even when retries are enabled. */
  nonRetryableStatuses?: WorkflowNodeStatus[];
}

export interface WorkflowInputDefinition {
  type?: "string" | "number" | "boolean" | "object" | "array";
  default?: unknown;
  description?: string;
  required?: boolean;
}

export interface WorkflowDefinition {
  version: number;
  name: string;
  description?: string;
  inputs?: Record<string, WorkflowInputDefinition>;
  policies?: WorkflowPolicies;
  nodes: WorkflowNodeDefinition[];
}

interface WorkflowNodeBase {
  id: string;
  type: WorkflowNodeType;
  dependsOn?: string[];
  model?: string;
  provider?: string;
  effort?: EffortLevel;
  maxTokens?: number;
  timeoutSeconds?: number;
  sandbox?: WorkflowPolicies["sandbox"];
  outputSchema?: Record<string, unknown>;
  retrySafe?: boolean;
  retryPolicy?: WorkflowRetryPolicy;
  idempotencyKey?: string;
  /**
   * Condition that must hold for this node to run.
   *
   * Supports `${...}` interpolation plus comparison, truthiness, and a small
   * set of helpers. A node whose condition is false is checkpointed `skipped`
   * with the reason, and its dependents are skipped with it, so a run records
   * *why* work did not happen rather than leaving a gap.
   *
   * ```yaml
   * when: ${nodes.triage.output.severity} == "high"
   * when: ${inputs.dryRun} != true
   * when: ${nodes.scan.output.count} > 0
   * ```
   */
  when?: string;
}

export interface WorkflowAgentNode extends WorkflowNodeBase {
  type: "agent";
  agent: string;
  task: string;
}

export interface WorkflowToolNode extends WorkflowNodeBase {
  type: "tool";
  tool: string;
  input?: Record<string, unknown>;
}

export type WorkflowAssertion =
  | { type: "output_contains"; node: string; value: string }
  | { type: "output_matches"; node: string; pattern: string }
  | { type: "json_schema"; node: string; schema: Record<string, unknown> }
  | { type: "file_exists"; path: string }
  | { type: "command"; command: string; sandbox?: WorkflowPolicies["sandbox"] }
  | { type: "tool_result"; node: string };

export interface WorkflowTestNode extends WorkflowNodeBase {
  type: "test";
  assertions: WorkflowAssertion[];
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  type: "approval";
  prompt: string;
}

export interface WorkflowPromptNode extends WorkflowNodeBase {
  type: "prompt" | "reduce";
  prompt: string;
  allowedTools?: string[];
}

export interface WorkflowSkillNode extends WorkflowNodeBase {
  type: "skill";
  skill: string;
  args?: string;
}

export interface WorkflowParallelNode extends WorkflowNodeBase {
  type: "parallel";
  children: WorkflowNodeDefinition[];
  maxConcurrency?: number;
}

export interface WorkflowLoopNode extends WorkflowNodeBase {
  type: "loop";
  maxIterations?: number;
  body: WorkflowNodeDefinition[];
  stopWhen?: {
    node: string;
    status?: WorkflowNodeStatus;
  };
  /** When true, a body node failure ends the loop instead of the next iteration. */
  stopOnFailure?: boolean;
}

export type WorkflowNodeDefinition =
  | WorkflowAgentNode
  | WorkflowToolNode
  | WorkflowTestNode
  | WorkflowApprovalNode
  | WorkflowPromptNode
  | WorkflowSkillNode
  | WorkflowParallelNode
  | WorkflowLoopNode;

export interface WorkflowUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface WorkflowApprovalDecision {
  decision: "approved" | "denied";
  approvedBy?: string;
  note?: string;
  decidedAt?: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersion: number;
  workflowHash: string;
  status: WorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
  inputs: Record<string, unknown>;
  policies: WorkflowPolicies;
  definition: WorkflowDefinition;
  currentNodeIds: string[];
  completedNodeIds: string[];
  failedNodeIds: string[];
  waitingApprovalNodeIds: string[];
  error?: string;
  /**
   * When this run's completion was announced to an operator.
   *
   * Undefined until reported. Mirrors the background-process record so a run
   * started detached can surface its result once, even if the session that
   * started it is long gone.
   */
  notifiedAt?: string;
}

/**
 * Token budget reported by an external agent node.
 *
 * External agents run out of process, so their consumption cannot be measured
 * directly. An agent may report a budget; when it does not,
 * `usageReported` is false so the gap is visible rather than read as zero.
 */
export interface WorkflowTokenBudget {
  limit?: number;
  used?: number;
  remaining?: number;
  period?: string;
}

export interface WorkflowNodeRun {
  id: string;
  type: WorkflowNodeType;
  status: WorkflowNodeStatus;
  attempt: number;
  nodeHash: string;
  startedAt?: string;
  endedAt?: string;
  input?: unknown;
  output?: unknown;
  summary?: string;
  usage?: WorkflowUsage;
  error?: string;
  /**
   * Which ceiling ended this node, when it timed out. Lets callers tell a
   * node's own timeout apart from the run-level `maxRuntimeSeconds` budget.
   */
  timedOutBy?: "node" | "run";
  approval?: WorkflowApprovalDecision;
  artifacts?: string[];
  skippedReason?: string;
  dryRun?: boolean;
  mocked?: boolean;
  /** For external agent nodes: whether the agent reported usage at all. */
  usageReported?: boolean;
  /** Token budget the external agent reported for itself, when provided. */
  tokenBudget?: WorkflowTokenBudget;
}

export interface WorkflowPendingNode {
  id: string;
  type: WorkflowNodeType;
  dependsOn?: string[];
}

export interface WorkflowRunSummary {
  run: WorkflowRun;
  nodes: WorkflowNodeRun[];
  pendingNodes: WorkflowPendingNode[];
}

export interface WorkflowMocks {
  nodes?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  skills?: Record<string, unknown>;
}

export interface WorkflowRunOptions {
  /**
   * How long a stopping run waits for in-flight nodes to finish before it
   * checkpoints them as cancelled and returns. Bounded so a tool that ignores
   * its abort signal cannot block process exit.
   */
  shutdownGraceMs?: number;
  dryRun?: boolean;
  force?: boolean;
  /**
   * Use this run id instead of minting one.
   *
   * A detached caller must record the run id before the run exists, so its job
   * record can be tied to the run directory and the run stays stoppable.
   */
  runId?: string;
  mocks?: WorkflowMocks;
  allowModelCalls?: boolean;
  allowCommands?: boolean;
  signal?: AbortSignal;
  approveRetry?: boolean;
}

export interface WorkflowEvalFixture {
  name: string;
  description?: string;
  inputs?: Record<string, unknown>;
  options?: WorkflowRunOptions;
  mocks?: WorkflowMocks;
  expect: WorkflowEvalExpectations;
}

export interface WorkflowEvalExpectations {
  status?: WorkflowRunStatus;
  nodes?: Record<string, WorkflowNodeStatus>;
  outputContains?: Record<string, string>;
  outputMatches?: Record<string, string>;
}

export interface WorkflowEvalResult {
  name: string;
  passed: boolean;
  runId: string;
  failures: string[];
}

export interface WorkflowEvalSummary {
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  results: WorkflowEvalResult[];
}

export interface WorkflowValidationIssue {
  path: string;
  message: string;
}

export interface WorkflowValidationResult {
  ok: boolean;
  issues: WorkflowValidationIssue[];
}
