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
  maxAttempts?: number;
  retryRunningAfterCrash?: boolean;
  requireApprovalBeforeRetry?: boolean;
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
  approval?: WorkflowApprovalDecision;
  artifacts?: string[];
  skippedReason?: string;
  dryRun?: boolean;
  mocked?: boolean;
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
  dryRun?: boolean;
  force?: boolean;
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
