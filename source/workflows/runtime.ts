import { Ajv } from "ajv";
import type { AgentDefinition } from "../agents/types.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop, type ConfirmResult } from "../agent/loop.js";
import type { AgavConfig, EffortLevel, PermissionMode } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { hashValue } from "./hash.js";
import { evaluateCondition } from "./condition.js";
import { interpolateString, interpolateValue } from "./interpolate.js";
import { WorkflowStore } from "./store.js";
import type {
  WorkflowAgentNode,
  WorkflowApprovalDecision,
  WorkflowApprovalNode,
  WorkflowDefinition,
  WorkflowMocks,
  WorkflowNodeDefinition,
  WorkflowNodeRun,
  WorkflowLoopNode,
  WorkflowNodeStatus,
  WorkflowParallelNode,
  WorkflowPromptNode,
  WorkflowRun,
  WorkflowRunOptions,
  WorkflowRunStatus,
  WorkflowSkillNode,
  WorkflowTestNode,
  WorkflowToolNode,
  WorkflowUsage,
  WorkflowTokenBudget,
} from "./types.js";
import { backoffDelayMs, effectiveMaxAttempts, resolveRetryDecision, shouldRetryNode } from "./retry.js";
import { validateWorkflow } from "./validator.js";

const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_STUCK_SCHEDULER_PASSES = 3;

/**
 * Default grace period for a clean stop: long enough for a cooperative tool to
 * notice its abort signal, short enough not to stall process exit.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;
const DEFAULT_MAX_ITERATIONS = 3;
const ajv = new Ajv({ allErrors: true, strict: false });

const DRY_RUN_SAFE_TOOLS = new Set([
  "read_file",
  "grep_search",
  "find_files",
  "list_directory",
  "web_search",
  "lsp_query",
  "read_notebook",
  "fetch_url",
  "overview",
  "run_tests",
]);

/** Output of an agent or skill node, with token accounting when available. */
export interface WorkflowAgentResult {
  output: string;
  usage?: WorkflowUsage;
  /** For external agents: whether the agent reported usage at all. */
  usageReported?: boolean;
  /** Token budget the external agent reported for itself, when provided. */
  tokenBudget?: WorkflowTokenBudget;
}

export interface AgentExecutionOptions {
  model?: string;
  effort?: EffortLevel;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  sandbox?: string;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export interface WorkflowApprovalRequest {
  run: WorkflowRun;
  node: WorkflowApprovalNode;
  prompt: string;
}

export interface WorkflowRuntimeDeps {
  provider: LLMProvider;
  config: AgavConfig;
  toolRegistry: ToolRegistry;
  loadAgent: (name: string) => Promise<AgentDefinition | null>;
  executeAgent: (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string | WorkflowAgentResult>;
  /**
   * Called when a stopping run had to abandon in-flight work, so a CLI can warn
   * that something may still be running in the background.
   */
  onShutdownWarning?: (message: string) => void;
  executeSkill?: (skill: string, args: string, options: AgentExecutionOptions) => Promise<string | WorkflowAgentResult>;
  confirm?: (request: WorkflowApprovalRequest) => Promise<WorkflowApprovalDecision>;
  confirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  store?: WorkflowStore;
  now?: () => Date;
  signal?: AbortSignal;
}

export async function runWorkflow(
  definition: WorkflowDefinition,
  inputs: Record<string, unknown>,
  deps: WorkflowRuntimeDeps,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRun> {
  const store = deps.store ?? new WorkflowStore();
  const resolvedInputs = resolveInputs(definition, inputs);
  const now = isoNow(deps);
  const run: WorkflowRun = {
    id: store.createRunId(),
    workflowName: definition.name,
    workflowVersion: definition.version,
    workflowHash: hashValue(definition),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    inputs: resolvedInputs,
    policies: definition.policies ?? {},
    definition,
    currentNodeIds: [],
    completedNodeIds: [],
    failedNodeIds: [],
    waitingApprovalNodeIds: [],
  };
  await store.saveRun(run);
  return executeWorkflowRun(run, deps, store, options);
}

export async function resumeWorkflow(
  runId: string,
  deps: WorkflowRuntimeDeps,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRun> {
  const store = deps.store ?? new WorkflowStore();
  const run = await store.loadRun(runId);
  if (!run) throw new Error(`Workflow run ${runId} not found`);
  // An explicitly cancelled run is an operator decision, so it needs `force`.
  if (run.status === "cancelled" && !options.force) {
    throw new Error(`Workflow run ${runId} is cancelled. Use force to resume it anyway.`);
  }
  if (run.status !== "running") run.status = "pending";

  // Clear the previous stop reason: a resumed run must not report the error that
  // ended the previous attempt before it has executed anything.
  run.error = undefined;

  return executeWorkflowRun(run, deps, store, options);
}

async function executeWorkflowRun(
  run: WorkflowRun,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
): Promise<WorkflowRun> {
  const validation = await validateWorkflow(run.definition, {
    hasTool: (name) => deps.toolRegistry.list().some((tool) => tool.schema.name === name),
    hasAgent: async (name) => Boolean(await deps.loadAgent(name)),
  });
  if (!validation.ok) {
    return saveRunStatus(run, store, deps, "failed", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }

  if (activeSignal(deps, options)?.aborted) return saveRunStatus(run, store, deps, "paused", "Workflow paused before execution");

  run.status = "running";
  run.updatedAt = isoNow(deps);
  await store.saveRun(run);


  // Run-level deadline. Unlike a node timeout, this bounds the whole run so a
  // slow loop or long chain cannot execute indefinitely. It is wall-clock time
  // from the moment execution starts, so it also covers retry backoff.
  const runDeadline = createRunDeadline(run, deps);
  const controller = createRunController(activeSignal(deps, options));
  // Only top-level nodes are scheduled by the run loop. Nested `parallel`
  // children are owned and scheduled by their parent node, so they must not
  // be treated as independent run-level nodes here.
  const allNodes = run.definition.nodes;
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const completedThisRun = new Set<string>();
  const failedThisRun = new Set<string>();
  const waitingThisRun = new Set<string>();
  const skippedThisRun = new Set<string>();
  let currentCheckpoints: Record<string, WorkflowNodeRun> = {};
  const lastAttemptByNode = new Map<string, number>();

  const budgetLimit = run.policies.tokenBudget ?? 0;
  let schedulerPasses = 0;
  let lastProgressSignature = "";

  while (true) {
    if (controller.aborted) return shutdownRun(run, store, deps, controller, options);
    if (runDeadline.expired()) return expireRun(run, store, deps, runDeadline, controller);
    // A model call cannot be interrupted once issued, so the budget is enforced
    // between nodes: the earliest point where the spend is known and no further
    // work has been started. The policy check is hoisted so an unbounded run does
    // no extra checkpoint I/O on every pass.
    if (budgetLimit > 0) {
      const budgetStopped = await enforceTokenBudget(run, store, deps, budgetLimit);
      if (budgetStopped) return budgetStopped;
    }

    // A full pass that changes no node state means the scheduler cannot make
    // further progress. Bail out instead of spinning forever.
    const progressSignature = JSON.stringify(
      allNodes.map((node) => `${node.id}:${(currentCheckpoints[node.id]?.status ?? "none")}:${currentCheckpoints[node.id]?.attempt ?? 0}`),
    );
    if (progressSignature === lastProgressSignature) {
      schedulerPasses++;
      if (schedulerPasses >= MAX_STUCK_SCHEDULER_PASSES) {
        return saveRunStatus(run, store, deps, "failed", "Workflow scheduler made no progress");
      }
    } else {
      schedulerPasses = 0;
      lastProgressSignature = progressSignature;
    }
    const checkpoints = await store.loadNodes(run.id);
    currentCheckpoints = checkpoints;
    const ready = allNodes.filter((node) => isReady(node, checkpoints, completedThisRun, failedThisRun, skippedThisRun, lastAttemptByNode, nodeById, Boolean(deps.confirm) || Boolean(options.dryRun) || Boolean(options.approveRetry), Boolean(options.dryRun)));


    if (ready.length === 0) {
      // A stop can land after the last node finished; the run must still report
      // itself stopped rather than passed.
      if (controller.aborted) return shutdownRun(run, store, deps, controller, options);

      const latest = await store.loadNodes(run.id);
      const terminal = summarizeTerminalState(allNodes, latest);
      run.completedNodeIds = terminal.completed;
      run.failedNodeIds = terminal.failed;
      run.waitingApprovalNodeIds = terminal.waiting;
      run.currentNodeIds = [];

      if (terminal.waiting.length > 0) return saveRunStatus(run, store, deps, "waiting_approval");
      if (terminal.failed.length > 0) return saveRunStatus(run, store, deps, "failed");
      return saveRunStatus(run, store, deps, "passed");
    }

    const maxConcurrency = Math.max(1, run.policies.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    const batch = ready.slice(0, maxConcurrency);
    run.currentNodeIds = batch.map((node) => node.id);
    run.updatedAt = isoNow(deps);
    await store.saveRun(run);

    await raceWithShutdown(Promise.all(batch.map(async (node) => {
      // Evaluate `when` right before execution so the condition sees the output
      // of whichever node it references, including one that just completed.
      if (node.when !== undefined) {
        const context = { inputs: run.inputs, nodes: await store.loadNodes(run.id) };
        const condition = evaluateCondition(node.when, context);
        if (!condition.ok) {
          const skippedRun = conditionSkipped(node, deps, condition.reason ?? "false");
          await store.saveNode(run.id, skippedRun);
          skippedThisRun.add(node.id);
          return;
        }
      }

      const result = await executeNode(run, node, deps, store, options, runDeadline, controller).catch(async (error: unknown) => {
        const attempt = await store.nextNodeAttempt(run.id, node.id);
        const failed = makeNodeRun(node, "failed", deps, { attempt, error: error instanceof Error ? error.message : String(error) });
        await store.saveNode(run.id, failed);
        return failed;
      });
      lastAttemptByNode.set(node.id, result.attempt);
      if (result.status === "passed") {
        completedThisRun.add(node.id);
        failedThisRun.delete(node.id);
      }
      if (result.status === "failed" || result.status === "timed_out" || result.status === "cancelled") failedThisRun.add(node.id);
      if (result.status === "waiting_approval") waitingThisRun.add(node.id);
      if (result.status === "skipped") skippedThisRun.add(node.id);
    })), controller);

    const backoff = computeBackoffDelayMs(allNodes, lastAttemptByNode);
    if (backoff > 0) {
      if (activeSignal(deps, options)?.aborted) return saveRunStatus(run, store, deps, "paused", "Workflow paused by signal");
      await sleep(backoff, activeSignal(deps, options));
    }

    if (waitingThisRun.size > 0) {
      const terminal = summarizeTerminalState(allNodes, await store.loadNodes(run.id));
      run.completedNodeIds = terminal.completed;
      run.failedNodeIds = terminal.failed;
      run.waitingApprovalNodeIds = terminal.waiting;
      run.currentNodeIds = [];
      return saveRunStatus(run, store, deps, "waiting_approval");
    }

    // A node that ran out of run budget did not fail on its own merits; let
    // the deadline check below report the run as `timed_out` instead.
    if (runDeadline.expired()) return expireRun(run, store, deps, runDeadline, controller);

    // Nodes stopped by shutdown land as `cancelled`, which would otherwise trip
    // stopOnFailure and report the run as `failed`. A stopped run is not a failed
    // run, so shutdown claims it first.
    if (controller.aborted) return shutdownRun(run, store, deps, controller, options);

    if ((run.policies.stopOnFailure ?? true) && [...failedThisRun].some((id) => isTerminalFailure(allNodes, id))) {
      const terminal = summarizeTerminalState(allNodes, await store.loadNodes(run.id));
      run.completedNodeIds = terminal.completed;
      run.failedNodeIds = terminal.failed;
      run.waitingApprovalNodeIds = terminal.waiting;
      run.currentNodeIds = [];
      return saveRunStatus(run, store, deps, "failed");
    }
  }
}

function isReady(
  node: WorkflowNodeDefinition,
  checkpoints: Record<string, WorkflowNodeRun>,
  completedThisRun: Set<string>,
  failedThisRun: Set<string>,
  skippedThisRun: Set<string>,
  lastAttemptByNode: Map<string, number>,
  nodeById: Map<string, WorkflowNodeDefinition>,
  canResumeApproval: boolean,
  dryRun: boolean,
): boolean {
  const existing = checkpoints[node.id];
  const hash = hashValue(node);
  if (existing?.status === "passed" && existing.nodeHash === hash) return false;
  if (existing?.status === "skipped" && existing.nodeHash === hash) return false;
  if (existing?.status === "waiting_approval") return canResumeApproval && (node.type === "approval" || existing.output === "retry_approval_required");
  if (existing?.status === "pending") return true;
  if (existing?.status === "cancelled") {
    if (existing.nodeHash !== hash) return false;
    // Interrupted by shutdown, not a failed attempt: always eligible to re-run.
    return true;
  }
  if (existing?.status === "failed" || existing?.status === "timed_out") {
    if (existing.nodeHash !== hash) return false;
    // A node that failed but still has retry budget goes back into the ready
    // set so the run loop can attempt it again.
    if (!shouldRetryNode(node)) return false;
    const nextAttempt = (existing.attempt ?? 0) + 1;
    if (nextAttempt > effectiveMaxAttempts(node)) return false;
    return true;
  }
  if (completedThisRun.has(node.id) || skippedThisRun.has(node.id)) return false;
  if (failedThisRun.has(node.id)) {
    const lastAttempt = lastAttemptByNode.get(node.id) ?? 0;
    if (lastAttempt + 1 > effectiveMaxAttempts(node)) return false;
    if (!shouldRetryNode(node)) return false;
  }

  for (const depId of node.dependsOn ?? []) {
    const dep = nodeById.get(depId);
    const depCheckpoint = checkpoints[depId];
    // A dependency skipped by its own `when` (or by a dry run) still unblocks the
  // next node. A dependent with no condition continues; one with its own `when`
  // is admitted so the condition decides, rather than becoming a silent no-op.
  const depSkipped = depCheckpoint?.status === "skipped";
  const satisfied = depCheckpoint?.status === "passed" || depSkipped || dryRun;
    if (!satisfied) return false;
    if (dep && depCheckpoint?.nodeHash !== hashValue(dep)) return false;
  }
  return true;
}

async function executeNode(
  run: WorkflowRun,
  node: WorkflowNodeDefinition,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  deadline?: RunDeadline,
  controller?: RunController,
): Promise<WorkflowNodeRun> {
  const attempt = await store.nextNodeAttempt(run.id, node.id);
  const existing = await store.loadNode(run.id, node.id);

  const decision = resolveRetryDecision({
    node,
    attempt,
    previous: existing,
    approveRetry: options.approveRetry === true,
    dryRun: options.dryRun === true,
  });

  if (decision.action === "reuse") {
    // Nothing to redo: the existing checkpoint already represents this node.
    return existing as WorkflowNodeRun;
  }

  if (decision.action === "wait_approval") {
    const waiting = makeNodeRun(node, "waiting_approval", deps, {
      attempt,
      input: existing?.input,
      output: "retry_approval_required",
      summary: decision.reason,
      skippedReason: "retry approval required",
    });
    await store.saveNode(run.id, waiting);
    return waiting;
  }

  if (decision.action === "exhausted") {
    const failed = makeNodeRun(node, "failed", deps, {
      attempt,
      error: decision.reason,
    });
    await store.saveNode(run.id, failed);
    return failed;
  }

  if (activeSignal(deps, options)?.aborted) {
    const cancelled = makeNodeRun(node, "cancelled", deps, { attempt, error: "Workflow paused by signal before node execution" });
    await store.saveNode(run.id, cancelled);
    return cancelled;
  }

  const started = makeNodeRun(node, "running", deps, { attempt });
  await store.saveNode(run.id, started);
  await trace(store, run.id, node.id, { type: "node_started", nodeId: node.id, nodeType: node.type, dryRun: options.dryRun === true });

  const mock = mockForNode(node, options.mocks);
  if (mock !== undefined) {
    const mocked = withValidatedOutput(node, makeNodeRun(node, "passed", deps, { attempt, input: mock.input, output: mock.output, summary: summarizeOutput(mock.output), mocked: true, dryRun: options.dryRun === true }));
    await store.saveNode(run.id, mocked);
    await trace(store, run.id, node.id, { type: "node_completed", nodeId: node.id, status: mocked.status, mocked: true });
    return mocked;
  }

  const executeCurrentNode = async (): Promise<WorkflowNodeRun> => {
    switch (node.type) {
      case "agent":
        return executeAgentNode(run, node, deps, store, options, attempt, controller?.signal);
      case "tool":
        return executeToolNode(run, node, deps, store, options, attempt, controller?.signal);
      case "test":
        return executeTestNode(run, node, deps, store, options, attempt);
      case "approval":
        return executeApprovalNode(run, node, deps, store, options, attempt);
      case "prompt":
      case "reduce":
        return executePromptNode(run, node, deps, store, options, attempt, controller?.signal);
      case "skill":
        return executeSkillNode(run, node, deps, store, options, attempt, controller?.signal);
      case "parallel":
        return executeParallelNode(run, node, deps, store, options, attempt);
      case "loop":
        return executeLoopNode(run, node, deps, store, options, attempt);
      default:
        return makeNodeRun(node, "failed", deps, { attempt, error: `Unsupported node type ${(node as WorkflowNodeDefinition).type}` });
    }
  };

  const work = executeCurrentNode();
  const tracked = controller ? controller.track(work) : work;
  const result = await withNodeTimeout(tracked, run, node, deps, attempt, options, deadline);

  // Preserve the start timestamp captured before execution so metrics and
  // status views report real elapsed time instead of a zero-length window.
  let completed = result.startedAt === started.startedAt ? result : { ...result, startedAt: started.startedAt };

  // A tool that ignores its signal can return well after the run expired.
  // Recording that late success would erase the timeout and make an overrun
  // look like a clean run, so the ceiling wins. This compares the node's own
  // end time to the ceiling rather than re-reading the clock, so a node that
  // genuinely finished in budget keeps its result regardless of scheduling.
  const finishedAt = completed.endedAt ? Date.parse(completed.endedAt) : Number.NaN;
  const overran = deadline?.bounded === true && deadline.expiresAt !== undefined
    && Number.isFinite(finishedAt) && finishedAt >= deadline.expiresAt;
  if (overran && completed.status === "passed" && result.timedOutBy === undefined) {
    completed = {
      ...completed,
      status: "timed_out",
      error: `Workflow exceeded maxRuntimeSeconds (${run.policies.maxRuntimeSeconds})`,
      timedOutBy: "run",
    };
  }

  await store.saveNode(run.id, completed);
  await trace(store, run.id, node.id, { type: "node_completed", nodeId: node.id, status: completed.status, dryRun: completed.dryRun === true });
  return completed;
}

async function executeAgentNode(
  run: WorkflowRun,
  node: WorkflowAgentNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
  runSignal?: AbortSignal,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const task = interpolateString(node.task, { inputs: run.inputs, nodes: checkpoints });
  if (options.dryRun) return drySkipped(node, deps, task, `Dry run: skipped agent ${node.agent}`, attempt);
  const agent = await deps.loadAgent(node.agent);
  if (!agent) return makeNodeRun(node, "failed", deps, { attempt, input: task, error: `Unknown agent: ${node.agent}` });

  const result = await deps.executeAgent(agent, task, executionOptions(run, node, deps, options, runSignal));
  const { output, usage, usageReported, tokenBudget } = normalizeAgentResult(result);
  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, {
    attempt,
    input: task,
    output,
    usage,
    usageReported,
    tokenBudget,
    summary: summarizeOutput(output),
  }));
}

async function executeToolNode(
  run: WorkflowRun,
  node: WorkflowToolNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
  runSignal?: AbortSignal,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const input = interpolateValue(node.input ?? {}, { inputs: run.inputs, nodes: checkpoints }) as Record<string, unknown>;
  if (node.sandbox && input["sandbox"] === undefined) input["sandbox"] = node.sandbox;
  if (options.dryRun && !isDryRunSafeTool(deps, node.tool)) return drySkipped(node, deps, input, `Dry run: skipped tool ${node.tool}`, attempt);
  const result = await deps.toolRegistry.execute(node.tool, input, { signal: runSignal, idempotencyKey: node.idempotencyKey ?? `${run.id}:${node.id}` });
  const output = normalizeToolResult(result);
  const status: WorkflowNodeStatus = result.isError ? "failed" : "passed";
  return withValidatedOutput(node, makeNodeRun(node, status, deps, { attempt, input, output, summary: summarizeOutput(output), error: result.isError ? result.output : undefined, dryRun: options.dryRun === true }));
}

async function executeTestNode(
  run: WorkflowRun,
  node: WorkflowTestNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
  runSignal?: AbortSignal,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const failures: string[] = [];
  const skipped: string[] = [];

  for (const assertion of node.assertions) {
    if (runSignal?.aborted) return makeNodeRun(node, "cancelled", deps, { attempt, error: "Workflow paused by signal during test node" });
    if (assertion.type === "output_contains") {
      const value = outputText(checkpoints[assertion.node]?.output);
      if (!value.includes(assertion.value)) failures.push(`${assertion.node} output does not contain ${assertion.value}`);
    } else if (assertion.type === "output_matches") {
      const value = outputText(checkpoints[assertion.node]?.output);
      if (!new RegExp(assertion.pattern).test(value)) failures.push(`${assertion.node} output does not match ${assertion.pattern}`);
    } else if (assertion.type === "json_schema") {
      const valid = ajv.validate(assertion.schema, checkpoints[assertion.node]?.output);
      if (!valid) failures.push(`${assertion.node} output failed schema: ${ajv.errorsText()}`);
    } else if (assertion.type === "tool_result") {
      const dep = checkpoints[assertion.node];
      if (!dep || (dep.status !== "passed" && !(options.dryRun && dep.status === "skipped"))) failures.push(`${assertion.node} did not pass`);
    } else if (assertion.type === "command") {
      if (options.dryRun && !options.allowCommands) {
        skipped.push(`command skipped in dry-run: ${assertion.command}`);
        continue;
      }
      const command = interpolateString(assertion.command, { inputs: run.inputs, nodes: checkpoints });
      const input: Record<string, unknown> = { command };
      const sandbox = assertion.sandbox ?? node.sandbox ?? run.policies.sandbox;
      if (sandbox) input.sandbox = sandbox;
      const result = await deps.toolRegistry.execute("run_command", input);
      if (result.isError) failures.push(`command failed: ${result.output}`);
    } else if (assertion.type === "file_exists") {
      const { existsSync } = await import("node:fs");
      const path = interpolateString(assertion.path, { inputs: run.inputs, nodes: checkpoints });
      if (!existsSync(path)) failures.push(`file does not exist: ${path}`);
    }
  }

  if (failures.length > 0) {
    return makeNodeRun(node, "failed", deps, { attempt, input: node.assertions, output: { failures, skipped }, summary: failures.join("\n"), error: failures.join("\n"), dryRun: options.dryRun === true });
  }
  return makeNodeRun(node, "passed", deps, { attempt, input: node.assertions, output: { passed: true, skipped }, summary: skipped.length > 0 ? `Assertions passed; ${skipped.length} command(s) skipped` : "All assertions passed", dryRun: options.dryRun === true });
}

async function executeApprovalNode(
  run: WorkflowRun,
  node: WorkflowApprovalNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const prompt = interpolateString(node.prompt, { inputs: run.inputs, nodes: checkpoints });
  if (options.dryRun) {
    const approval: WorkflowApprovalDecision = { decision: "approved", approvedBy: "dry-run", decidedAt: isoNow(deps), note: "Synthetic dry-run approval" };
    return makeNodeRun(node, "passed", deps, { attempt, input: prompt, output: approval, summary: "Dry run: synthetic approval", approval, dryRun: true });
  }
  if (!deps.confirm) {
    return makeNodeRun(node, "waiting_approval", deps, { attempt, input: prompt, summary: prompt });
  }
  const decision = await deps.confirm({ run, node, prompt });
  const approval = { ...decision, decidedAt: decision.decidedAt ?? isoNow(deps) };
  if (approval.decision === "approved") {
    return makeNodeRun(node, "passed", deps, { attempt, input: prompt, output: approval, summary: "Approved", approval });
  }
  return makeNodeRun(node, "failed", deps, { attempt, input: prompt, output: approval, summary: "Denied", error: "Approval denied", approval });
}

async function executePromptNode(
  run: WorkflowRun,
  node: WorkflowPromptNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
  runSignal?: AbortSignal,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const prompt = interpolateString(node.prompt, { inputs: run.inputs, nodes: checkpoints });
  if (options.dryRun && !options.allowModelCalls) return drySkipped(node, deps, prompt, "Dry run: skipped model prompt", attempt);
  const conversation = new ConversationState();
  conversation.addUserMessage(prompt);
  const registry = filterRegistry(deps.toolRegistry, node.allowedTools);
  let output = "";
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let error: string | undefined;

  for await (const event of runAgentLoop({
    provider: deps.provider,
    conversation,
    toolRegistry: registry,
    model: node.model ?? deps.config.model,
    systemPrompt: deps.config.systemPrompt,
    effort: node.effort ?? deps.config.effort,
    maxTokens: node.maxTokens ?? deps.config.maxTokens,
    signal: activeSignal(deps, options),
    confirmTool: deps.confirmTool,
    permissionMode: run.policies.permissionMode ?? deps.config.permissionMode,
    maxIterations: 20,
  })) {
    if (event.type === "streaming_text") output += event.text;
    if (event.type === "assistant_message_complete") output = event.text || output;
    if (event.type === "usage") {
      usage.inputTokens += event.inputTokens;
      usage.outputTokens += event.outputTokens;
      usage.cacheReadTokens += event.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
    }
    if (event.type === "error") error = event.error.message;
  }

  const status: WorkflowNodeStatus = error ? "failed" : "passed";
  return withValidatedOutput(node, makeNodeRun(node, status, deps, { attempt, input: prompt, output, usage, summary: summarizeOutput(output), error, dryRun: options.dryRun === true }));
}

async function executeSkillNode(
  run: WorkflowRun,
  node: WorkflowSkillNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
  runSignal?: AbortSignal,
): Promise<WorkflowNodeRun> {
  if (!deps.executeSkill) return makeNodeRun(node, "failed", deps, { attempt, error: "No skill executor configured" });
  const checkpoints = await store.loadNodes(run.id);
  const args = interpolateString(node.args ?? "", { inputs: run.inputs, nodes: checkpoints });
  if (options.dryRun) return drySkipped(node, deps, args, `Dry run: skipped skill ${node.skill}`, attempt);
  const result = await deps.executeSkill(node.skill, args, executionOptions(run, node, deps, options, runSignal));
  const { output, usage } = normalizeAgentResult(result);
  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, { attempt, input: args, output, usage, summary: summarizeOutput(output) }));
}

async function executeParallelNode(
  run: WorkflowRun,
  node: WorkflowParallelNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
): Promise<WorkflowNodeRun> {
  const children = node.children ?? [];
  const childById = new Map(children.map((child) => [child.id, child]));
  const maxConcurrency = Math.max(1, node.maxConcurrency ?? run.policies.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);

  // Children that already completed (for example on a resumed run) count as done
  // so the fan-out does not fail on a replay and does not re-execute them.
  const done = new Set<string>();
  const initialCheckpoints = await store.loadNodes(run.id);
  for (const child of children) {
    const existing = initialCheckpoints[child.id];
    if (existing?.nodeHash !== hashValue(child)) continue;
    if (existing.status === "passed" || existing.status === "skipped" || existing.status === "waiting_approval") {
      done.add(child.id);
    }
  }

  let guard = children.length * children.length + children.length + 2;

  while (done.size < children.length) {
    if (activeSignal(deps, options)?.aborted) {
      return makeNodeRun(node, "cancelled", deps, { attempt, error: "Workflow paused by signal during parallel node" });
    }
    if (guard-- <= 0) {
      const stuck = children.filter((child) => !done.has(child.id)).map((child) => child.id);
      return makeNodeRun(node, "failed", deps, { attempt, error: `Parallel node stalled; unfinished children: ${stuck.join(", ")}` });
    }

    const checkpoints = await store.loadNodes(run.id);
    const ready = children.filter((child) => {
      if (done.has(child.id)) return false;
      const existing = checkpoints[child.id];
      if (existing?.status === "passed" && existing.nodeHash === hashValue(child)) return false;
      if (existing?.status === "skipped" && existing.nodeHash === hashValue(child)) return false;
      if (existing?.status === "failed" && existing.nodeHash === hashValue(child)) return false;
      return (child.dependsOn ?? []).every((depId) => {
        if (childById.has(depId)) return done.has(depId);
        const depCheckpoint = checkpoints[depId];
        return depCheckpoint?.status === "passed" || (options.dryRun === true && depCheckpoint?.status === "skipped");
      });
    });

    if (ready.length === 0) {
      const blocked = children.filter((child) => !done.has(child.id)).map((child) => child.id);
      return makeNodeRun(node, "failed", deps, { attempt, error: `Parallel node made no progress; unfinished children: ${blocked.join(", ")}` });
    }

    const batch = ready.slice(0, maxConcurrency);
    const results = await Promise.all(batch.map((child) => executeNode(run, child, deps, store, options)));

    for (const result of results) {
      if (result.status === "passed" || result.status === "skipped" || result.status === "waiting_approval") {
        done.add(result.id);
      }
    }

    const failures = results.filter((result) => result.status === "failed" || result.status === "timed_out" || result.status === "cancelled");
    if (failures.length > 0) {
      const childOutputs: Record<string, unknown> = {};
      for (const result of results) childOutputs[result.id] = result.output;
      return makeNodeRun(node, "failed", deps, {
        attempt,
        input: children.map((child) => child.id),
        output: { childOutputs },
        summary: `Parallel children failed: ${failures.map((result) => `${result.id} (${result.status})`).join(", ")}`,
        error: failures.map((result) => result.error ?? result.status).join("; "),
      });
    }
  }

  const finalCheckpoints = await store.loadNodes(run.id);
  const childOutputs: Record<string, unknown> = {};
  for (const child of children) childOutputs[child.id] = finalCheckpoints[child.id]?.output;

  const waiting = children.filter((child) => finalCheckpoints[child.id]?.status === "waiting_approval");
  if (waiting.length > 0) {
    return makeNodeRun(node, "waiting_approval", deps, {
      attempt,
      input: children.map((child) => child.id),
      output: { childOutputs, awaitingApproval: waiting.map((child) => child.id) },
      summary: `Parallel children awaiting approval: ${waiting.map((child) => child.id).join(", ")}`,
    });
  }

  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, {
    attempt,
    input: children.map((child) => child.id),
    output: { childOutputs },
    summary: `Completed ${children.length} parallel child node(s)`,
  }));
}

async function executeLoopNode(
  run: WorkflowRun,
  node: WorkflowLoopNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
): Promise<WorkflowNodeRun> {
  const body = node.body ?? [];
  const bodyIds = new Set(body.map((child) => child.id));
  const maxIterations = node.maxIterations ?? run.policies.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const stopWhenNode = node.stopWhen?.node;
  const stopWhenStatus = node.stopWhen?.status ?? "passed";

  if (stopWhenNode && !bodyIds.has(stopWhenNode)) {
    return makeNodeRun(node, "failed", deps, {
      attempt,
      error: `Loop stopWhen node ${stopWhenNode} must be a body node`,
    });
  }

  // A loop always restarts from iteration 1 unless it already finished, so an
  // interrupted run replays the body deterministically. Per-iteration
  // checkpoints prevent re-executing iterations that already completed.
  const iterations: Array<Record<string, unknown>> = [];
  let completedIterations = 0;
  let stoppedEarly = false;
  let exhaustedFailure: string | undefined;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (activeSignal(deps, options)?.aborted) {
      return makeNodeRun(node, "cancelled", deps, {
        attempt,
        input: { maxIterations },
        output: { iterations, completedIterations, interruptedAt: iteration },
        summary: `Workflow paused by signal at loop iteration ${iteration}`,
        error: "Workflow paused by signal during loop node",
      });
    }

    const bodyRun = await executeLoopIteration(run, node, body, iteration, deps, store, options);
    iterations.push(bodyRun.outputs);

    if (bodyRun.status === "waiting_approval") {
      return makeNodeRun(node, "waiting_approval", deps, {
        attempt,
        input: { maxIterations },
        output: { iterations, completedIterations, awaitingApproval: bodyRun.awaitingApproval },
        summary: `Loop iteration ${iteration} awaiting approval: ${bodyRun.awaitingApproval?.join(", ")}`,
      });
    }

    if (bodyRun.status === "failed" || bodyRun.status === "timed_out" || bodyRun.status === "cancelled") {
      if (node.stopOnFailure ?? true) {
        return makeNodeRun(node, "failed", deps, {
          attempt,
          input: { maxIterations },
          output: { iterations, completedIterations: completedIterations + 1, failedIteration: iteration },
          summary: `Loop iteration ${iteration} failed: ${bodyRun.summary ?? bodyRun.status}`,
          error: bodyRun.error ?? bodyRun.status,
        });
      }
      // A non-fatal body failure counts as a completed iteration so the loop
      // can continue and retry the work on the next pass.
      completedIterations = iteration;
      exhaustedFailure = bodyRun.error ?? bodyRun.status;
      if (stopWhenNode && bodyRun.statuses[stopWhenNode] === stopWhenStatus) {
        stoppedEarly = true;
        break;
      }
      continue;
    }

    completedIterations = iteration;
    exhaustedFailure = undefined;

    if (stopWhenNode && bodyRun.statuses[stopWhenNode] === stopWhenStatus) {
      stoppedEarly = true;
      break;
    }
  }

  if (exhaustedFailure) {
    return makeNodeRun(node, "failed", deps, {
      attempt,
      input: { maxIterations },
      output: { iterations, completedIterations, exhausted: true },
      summary: `Loop exhausted after ${completedIterations} iteration(s) without satisfying stopWhen`,
      error: exhaustedFailure,
    });
  }

  const summary = stoppedEarly
    ? `Loop stopped after ${completedIterations} iteration(s) because ${stopWhenNode} was ${stopWhenStatus}`
    : `Loop completed ${completedIterations} iteration(s) without satisfying stopWhen`;

  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, {
    attempt,
    input: { maxIterations },
    output: { iterations, completedIterations, stoppedEarly, exhausted: !stoppedEarly },
    summary,
  }));
}

async function executeLoopIteration(
  run: WorkflowRun,
  node: WorkflowLoopNode,
  body: WorkflowNodeDefinition[],
  iteration: number,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
): Promise<LoopIterationResult> {
  const bodyById = new Map(body.map((child) => [child.id, child]));
  const maxConcurrency = Math.max(1, run.policies.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const outputs: Record<string, unknown> = {};
  const statuses: Record<string, WorkflowNodeStatus> = {};
  const done = new Set<string>();
  const awaitingApproval: string[] = [];

  // Reuse checkpoints from earlier attempts of this run so an interrupted
  // loop does not re-run body nodes that already produced a result.
  const initialCheckpoints = await store.loadNodes(run.id);
  for (const child of body) {
    const existing = initialCheckpoints[loopNodeKey(child.id, iteration)];
    if (!existing || existing.nodeHash !== hashValue(scopedLoopNode(child, iteration))) continue;
    if (existing.status === "running") continue;
    outputs[child.id] = existing.output;
    statuses[child.id] = existing.status;
    done.add(child.id);
    if (existing.status === "waiting_approval") awaitingApproval.push(child.id);
  }

  let guard = body.length * body.length + body.length + 2;

  while (done.size < body.length) {
    if (activeSignal(deps, options)?.aborted) {
      return { status: "cancelled", outputs, statuses, error: "Workflow paused by signal during loop iteration" };
    }
    if (awaitingApproval.length > 0) {
      return { status: "waiting_approval", outputs, statuses, awaitingApproval: [...awaitingApproval] };
    }
    if (guard-- <= 0) {
      const stuck = body.filter((child) => !done.has(child.id)).map((child) => child.id);
      return { status: "failed", outputs, statuses, error: `Loop iteration stalled; unfinished body nodes: ${stuck.join(", ")}` };
    }

    const checkpoints = await store.loadNodes(run.id);
    const ready = body.filter((child) => {
      if (done.has(child.id)) return false;
      return (child.dependsOn ?? []).every((depId) => {
        if (bodyById.has(depId)) return done.has(depId);
        const depCheckpoint = checkpoints[depId];
        return depCheckpoint?.status === "passed" || (options.dryRun === true && depCheckpoint?.status === "skipped");
      });
    });

    if (ready.length === 0) {
      const blocked = body.filter((child) => !done.has(child.id)).map((child) => child.id);
      return { status: "failed", outputs, statuses, error: `Loop iteration made no progress; unfinished body nodes: ${blocked.join(", ")}` };
    }

    const batch = ready.slice(0, maxConcurrency);
    const settled = await Promise.all(
      batch.map(async (child) => ({ child, result: await executeLoopBodyNode(run, child, iteration, deps, store, options) })),
    );

    let failed: string | undefined;
    for (const { child, result } of settled) {
      outputs[child.id] = result.output;
      statuses[child.id] = result.status;
      if (result.status === "waiting_approval") {
        awaitingApproval.push(child.id);
        continue;
      }
      if (result.status === "failed" || result.status === "timed_out" || result.status === "cancelled") {
        failed = [failed, result.error ?? result.status].filter(Boolean).join("; ") ?? result.status;
        continue;
      }
      done.add(child.id);
    }

    if (awaitingApproval.length > 0) {
      return { status: "waiting_approval", outputs, statuses, awaitingApproval: [...awaitingApproval] };
    }
    if (failed) {
      return { status: "failed", outputs, statuses, error: failed };
    }
  }

  return { status: "passed", outputs, statuses };
}

interface LoopIterationResult {
  status: WorkflowNodeStatus;
  outputs: Record<string, unknown>;
  statuses: Record<string, WorkflowNodeStatus>;
  awaitingApproval?: string[];
  error?: string;
  summary?: string;
}

function loopNodeKey(nodeId: string, iteration: number): string {
  return `${nodeId}#${iteration}`;
}

function scopedLoopNode(child: WorkflowNodeDefinition, iteration: number): WorkflowNodeDefinition {
  return { ...child, id: loopNodeKey(child.id, iteration) };
}

async function executeLoopBodyNode(
  run: WorkflowRun,
  child: WorkflowNodeDefinition,
  iteration: number,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
): Promise<WorkflowNodeRun> {
  return executeNode(run, scopedLoopNode(child, iteration), deps, store, options);
}

function isTerminalFailure(nodes: WorkflowNodeDefinition[], nodeId: string): boolean {
  const node = nodes.find((entry) => entry.id === nodeId);
  if (!node) return true;
  return !shouldRetryNode(node);
}

function computeBackoffDelayMs(nodes: WorkflowNodeDefinition[], lastAttemptByNode: Map<string, number>): number {
  let delay = 0;
  for (const node of nodes) {
    const attempt = lastAttemptByNode.get(node.id);
    if (attempt === undefined) continue;
    if (!shouldRetryNode(node)) continue;
    if (attempt >= effectiveMaxAttempts(node)) continue;
    delay = Math.max(delay, backoffDelayMs(node.retryPolicy, attempt));
  }
  return delay;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Accept executors that return a plain string (older callers) or a result
 * carrying token usage.
 */
function normalizeAgentResult(result: string | WorkflowAgentResult): {
  output: string;
  usage?: WorkflowUsage;
  usageReported?: boolean;
  tokenBudget?: WorkflowTokenBudget;
} {
  if (typeof result === "string") return { output: result };
  const usage = result.usage
    ? {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        cacheReadTokens: result.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
      }
    : undefined;
  return { output: result.output, usage, usageReported: result.usageReported, tokenBudget: result.tokenBudget };
}

function makeNodeRun(
  node: WorkflowNodeDefinition,
  status: WorkflowNodeStatus,
  deps: WorkflowRuntimeDeps,
  extra: Partial<WorkflowNodeRun> = {},
): WorkflowNodeRun {
  const now = isoNow(deps);
  return {
    id: node.id,
    type: node.type,
    status,
    attempt: extra.attempt ?? 1,
    nodeHash: hashValue(node),
    startedAt: extra.startedAt ?? now,
    endedAt: status === "running" || status === "waiting_approval" ? undefined : extra.endedAt ?? now,
    ...extra,
  };
}

function withValidatedOutput(node: WorkflowNodeDefinition, nodeRun: WorkflowNodeRun): WorkflowNodeRun {
  if (!node.outputSchema || (nodeRun.status !== "passed" && nodeRun.status !== "skipped")) return nodeRun;
  let output = nodeRun.output;
  if (typeof output === "string") {
    try { output = JSON.parse(output); } catch {}
  }
  const valid = ajv.validate(node.outputSchema, output);
  if (!valid) {
    return {
      ...nodeRun,
      status: "failed",
      output,
      error: `Output schema validation failed: ${ajv.errorsText()}`,
      endedAt: nodeRun.endedAt ?? new Date().toISOString(),
    };
  }
  return { ...nodeRun, output };
}

function resolveInputs(definition: WorkflowDefinition, supplied: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(definition.inputs ?? {})) {
    if (supplied[key] !== undefined) out[key] = supplied[key];
    else if (spec.default !== undefined) out[key] = spec.default;
  }
  return { ...out, ...supplied };
}

function executionOptions(run: WorkflowRun, node: WorkflowNodeDefinition, deps: WorkflowRuntimeDeps, options: WorkflowRunOptions, runSignal?: AbortSignal): AgentExecutionOptions {
  return {
    model: node.model,
    effort: node.effort,
    maxTokens: node.maxTokens,
    permissionMode: run.policies.permissionMode,
    sandbox: node.sandbox ?? run.policies.sandbox,
    signal: activeSignal(deps, options),
    idempotencyKey: node.idempotencyKey ?? `${run.id}:${node.id}`,
  };
}

function filterRegistry(registry: ToolRegistry, allowed?: string[]): ToolRegistry {
  if (!allowed || allowed.length === 0) return new ToolRegistry();
  const child = new ToolRegistry();
  const allowedSet = new Set(allowed);
  for (const tool of registry.list()) {
    if (allowedSet.has(tool.schema.name)) child.register(tool);
  }
  return child;
}

function normalizeToolResult(result: ToolResult): unknown {
  try {
    return JSON.parse(result.output);
  } catch {
    return result.output;
  }
}

function outputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function summarizeOutput(output: unknown): string {
  const text = outputText(output);
  return text.length > 500 ? `${text.slice(0, 500)}\n...(truncated)` : text;
}

interface RunDeadline {
  /** Wall-clock expiry in epoch ms, or undefined when the run is unbounded. */
  expiresAt?: number;
  /** True when a budget is configured, even if it has not yet elapsed. */
  bounded: boolean;
  expired(): boolean;
  remainingMs(): number | undefined;
}

/**
 * Build the run-level deadline from `policies.maxRuntimeSeconds`.
 *
 * The clock starts when the run begins executing, so a resumed run gets a
 * fresh budget rather than inheriting time already spent in a prior process.
 */
function createRunDeadline(run: WorkflowRun, deps: WorkflowRuntimeDeps): RunDeadline {
  const maxSeconds = run.policies.maxRuntimeSeconds;
  if (!maxSeconds || maxSeconds <= 0) {
    return { bounded: false, expired: () => false, remainingMs: () => undefined };
  }
  const now = (deps.now?.() ?? new Date()).getTime();
  const expiresAt = now + maxSeconds * 1000;
  const read = (): number => (deps.now?.() ?? new Date()).getTime();
  return {
    bounded: true,
    expiresAt,
    expired: () => read() >= expiresAt,
    remainingMs: () => Math.max(0, expiresAt - read()),
  };
}

/**
 * Mark a run as timed out, checkpointing any node that was still in flight as
 * `timed_out` so the partial state is inspectable and resumable.
 */
export type ShutdownReason = "cancelled" | "paused" | "timed_out";

/**
 * A run-scoped controller that owns cancellation for the whole run.
 *
 * Cancellation used to be checked at scattered call sites, so a tool that
 * ignored its signal was abandoned mid-flight. The controller centralises
 * aborting and lets shutdown await in-flight work, so the process can exit
 * with the run left clean and resumable.
 */
export interface RunController {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  readonly reason: ShutdownReason | undefined;
  abort(reason: ShutdownReason): void;
  track<T>(work: Promise<T>): Promise<T>;
  settle(graceMs: number): Promise<{ drained: boolean; abandoned: number }>;
}

export function createRunController(parent?: AbortSignal): RunController {
  const inner = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  let reason: ShutdownReason | undefined;

  if (parent) {
    if (parent.aborted) {
      reason = "paused";
      inner.abort(parent.reason);
    } else {
      parent.addEventListener("abort", () => {
        if (!reason) reason = "paused";
        inner.abort(parent.reason);
      }, { once: true });
    }
  }

  return {
    signal: inner.signal,
    get aborted() { return inner.signal.aborted; },
    get reason() { return reason; },
    abort(next: ShutdownReason) {
      if (inner.signal.aborted) return;
      reason = next;
      inner.abort(new Error("Workflow " + next));
    },
    track<T>(work: Promise<T>): Promise<T> {
      inFlight.add(work);
      const done = () => { inFlight.delete(work); };
      work.then(done, done);
      return work;
    },
    async settle(graceMs: number) {
      if (inFlight.size === 0) return { drained: true, abandoned: 0 };
      const pending = [...inFlight];
      const timeout = new Promise<"timeout">((resolve) => {
        const t = setTimeout(() => resolve("timeout"), graceMs);
        t.unref?.();
      });
      const result = await Promise.race([Promise.allSettled(pending).then(() => "drained" as const), timeout]);
      if (result === "drained") return { drained: true, abandoned: 0 };
      return { drained: false, abandoned: inFlight.size };
    },
  };
}

/**
 * Await a batch, but stop waiting as soon as the run is asked to stop.
 *
 * Without this the scheduler blocks on a tool that ignores its abort signal,
 * so the grace period can never bound it and the process cannot exit cleanly.
 */
async function raceWithShutdown<T>(batch: Promise<T>, controller: RunController): Promise<T | undefined> {
  if (controller.aborted) return undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([batch, aborted]);
  } finally {
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Stop a run cleanly: abort in-flight work, wait a bounded grace period, then
 * checkpoint anything still running as `cancelled` so the run stays resumable.
 */
/**
 * Tokens consumed so far by a run, summed from its node checkpoints.
 *
 * Budget enforcement reads the persisted checkpoints rather than an in-memory
 * counter so it stays correct across resumes, where earlier nodes ran in a
 * previous process.
 */
async function consumedTokens(run: WorkflowRun, store: WorkflowStore): Promise<number> {
  const checkpoints = await store.loadNodes(run.id);
  let total = 0;
  for (const node of Object.values(checkpoints)) {
    total += (node.usage?.inputTokens ?? 0) + (node.usage?.outputTokens ?? 0);
  }
  return total;
}

/**
 * Stop a run that has exceeded `policies.tokenBudget`.
 *
 * The budget is checked between nodes rather than mid-call: a model call cannot
 * be interrupted once issued, so the earliest correct place to act is the point
 * where the spend becomes known and no further work has started.
 */
async function enforceTokenBudget(
  run: WorkflowRun,
  store: WorkflowStore,
  deps: WorkflowRuntimeDeps,
  limit: number,
): Promise<WorkflowRun | undefined> {

  const used = await consumedTokens(run, store);
  if (used < limit) return undefined;

  const message = `Workflow exceeded its tokenBudget (${used}/${limit} tokens)`;
  const checkpoints = await store.loadNodes(run.id);
  for (const node of run.definition.nodes) {
    const checkpoint = checkpoints[node.id];
    if (checkpoint?.status === "running") {
      await store.saveNode(run.id, {
        ...checkpoint,
        status: "failed",
        endedAt: isoNow(deps),
        error: message,
      });
    }
  }

  const latest = await store.loadNodes(run.id);
  const terminal = summarizeTerminalState(run.definition.nodes, latest);
  run.completedNodeIds = terminal.completed;
  run.failedNodeIds = terminal.failed;
  run.waitingApprovalNodeIds = terminal.waiting;
  run.currentNodeIds = [];

  return saveRunStatus(run, store, deps, "failed", message);
}
async function shutdownRun(
  run: WorkflowRun,
  store: WorkflowStore,
  deps: WorkflowRuntimeDeps,
  controller: RunController,
  options: WorkflowRunOptions,
): Promise<WorkflowRun> {
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const { drained, abandoned } = await controller.settle(graceMs);

  const reason = controller.reason ?? "paused";
  const message = reason === "timed_out"
    ? `Workflow exceeded maxRuntimeSeconds (${run.policies.maxRuntimeSeconds})`
    : "Workflow stopped by signal";

  const checkpoints = await store.loadNodes(run.id);
  for (const node of run.definition.nodes) {
    const checkpoint = checkpoints[node.id];
    if (checkpoint?.status === "running") {
      await store.saveNode(run.id, {
        ...checkpoint,
        status: "cancelled",
        endedAt: isoNow(deps),
        error: message,
      });
    }
  }

  const latest = await store.loadNodes(run.id);
  const terminal = summarizeTerminalState(run.definition.nodes, latest);
  run.completedNodeIds = terminal.completed;
  run.failedNodeIds = terminal.failed;
  run.waitingApprovalNodeIds = terminal.waiting;
  run.currentNodeIds = [];

  const saved = await saveRunStatus(run, store, deps, reason === "cancelled" ? "cancelled" : "paused", message);

  if (!drained && abandoned > 0) {
    deps.onShutdownWarning?.(
      abandoned + " workflow task(s) did not stop within " + graceMs + "ms and may still be running",
    );
  }
  return saved;
}
async function expireRun(
  run: WorkflowRun,
  store: WorkflowStore,
  deps: WorkflowRuntimeDeps,
  deadline: RunDeadline,
  controller: RunController,
): Promise<WorkflowRun> {
  const limit = run.policies.maxRuntimeSeconds;
  const message = `Workflow exceeded maxRuntimeSeconds (${limit})`;

  // Signal in-flight tools before checkpointing so they stop promptly instead of
  // being abandoned mid-flight.
  controller.abort("timed_out");

  const checkpoints = await store.loadNodes(run.id);
  for (const node of run.definition.nodes) {
    const checkpoint = checkpoints[node.id];
    if (checkpoint?.status === "running") {
      await store.saveNode(run.id, {
        ...checkpoint,
        status: "timed_out",
        endedAt: isoNow(deps),
        error: message,
      });
    }
  }

  const latest = await store.loadNodes(run.id);
  const terminal = summarizeTerminalState(run.definition.nodes, latest);
  run.completedNodeIds = terminal.completed;
  run.failedNodeIds = terminal.failed;
  run.waitingApprovalNodeIds = terminal.waiting;
  run.currentNodeIds = [];

  return saveRunStatus(run, store, deps, "timed_out", message);
}

function summarizeTerminalState(nodes: WorkflowNodeDefinition[], checkpoints: Record<string, WorkflowNodeRun>) {
  return {
    completed: nodes.filter((node) => checkpoints[node.id]?.status === "passed").map((node) => node.id),
    failed: nodes.filter((node) => checkpoints[node.id]?.status === "failed" || checkpoints[node.id]?.status === "timed_out").map((node) => node.id),
    // Interrupted by shutdown: eligible to re-run, not a failure.
    cancelled: nodes.filter((node) => checkpoints[node.id]?.status === "cancelled").map((node) => node.id),
    waiting: nodes.filter((node) => checkpoints[node.id]?.status === "waiting_approval").map((node) => node.id),
  };
}

async function saveRunStatus(
  run: WorkflowRun,
  store: WorkflowStore,
  deps: WorkflowRuntimeDeps,
  status: WorkflowRunStatus,
  error?: string,
): Promise<WorkflowRun> {
  run.status = status;
  run.updatedAt = isoNow(deps);
  if (error) run.error = error;
  await store.saveRun(run);
  return run;
}

async function trace(store: WorkflowStore, runId: string, nodeId: string, event: Record<string, unknown>): Promise<void> {
  await store.appendLog(runId, nodeId, JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function isoNow(deps: WorkflowRuntimeDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function activeSignal(deps: WorkflowRuntimeDeps, options: WorkflowRunOptions): AbortSignal | undefined {
  return options.signal ?? deps.signal;
}

async function withNodeTimeout(
  promise: Promise<WorkflowNodeRun>,
  run: WorkflowRun,
  node: WorkflowNodeDefinition,
  deps: WorkflowRuntimeDeps,
  attempt: number,
  options: WorkflowRunOptions,
  deadline?: RunDeadline,
): Promise<WorkflowNodeRun> {
  const nodeSeconds = node.timeoutSeconds ?? run.policies.maxNodeRuntimeSeconds;

  // A node may never outlive the run. When the run has a deadline, the
  // remaining budget caps the node, so a single slow node or a long loop
  // iteration cannot push the run past its ceiling.
  const remainingMs = deadline?.bounded ? deadline.remainingMs() : undefined;
  const effectiveMs = Math.min(
    nodeSeconds !== undefined && nodeSeconds > 0 ? nodeSeconds * 1000 : Number.POSITIVE_INFINITY,
    remainingMs ?? Number.POSITIVE_INFINITY,
  );

  if (!Number.isFinite(effectiveMs) || effectiveMs <= 0) return promise;

  const runCapped = remainingMs !== undefined && remainingMs <= (nodeSeconds ?? Number.POSITIVE_INFINITY) * 1000;
  const error = runCapped
    ? `Workflow exceeded maxRuntimeSeconds (${run.policies.maxRuntimeSeconds})`
    : `Node timed out after ${nodeSeconds} seconds`;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<WorkflowNodeRun>((resolve) => {
    timeout = setTimeout(() => {
      resolve(makeNodeRun(node, "timed_out", deps, {
        attempt,
        error,
        timedOutBy: runCapped ? "run" : "node",
        dryRun: options.dryRun === true,
      }));
    }, effectiveMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function mockForNode(node: WorkflowNodeDefinition, mocks?: WorkflowMocks): { input?: unknown; output: unknown } | undefined {
  if (!mocks) return undefined;
  const nodeMock = mocks.nodes?.[node.id];
  if (nodeMock !== undefined) return normalizeMock(nodeMock);
  if (node.type === "tool") {
    const mock = mocks.tools?.[node.tool];
    if (mock !== undefined) return normalizeMock(mock);
  }
  if (node.type === "agent") {
    const mock = mocks.agents?.[node.agent];
    if (mock !== undefined) return normalizeMock(mock);
  }
  if (node.type === "skill") {
    const mock = mocks.skills?.[node.skill];
    if (mock !== undefined) return normalizeMock(mock);
  }
  return undefined;
}

function normalizeMock(value: unknown): { input?: unknown; output: unknown } {
  if (value && typeof value === "object" && "output" in value) {
    const record = value as { input?: unknown; output: unknown };
    return { input: record.input, output: record.output };
  }
  return { output: value };
}

/**
 * Skip a node whose `when` condition evaluated false.
 *
 * Recorded as a normal `skipped` checkpoint rather than silently omitted, so a
 * run shows why a branch did not execute and the decision survives a resume.
 */
function conditionSkipped(node: WorkflowNodeDefinition, deps: WorkflowRuntimeDeps, reason: string, attempt = 1): WorkflowNodeRun {
  return makeNodeRun(node, "skipped", deps, {
    attempt,
    output: { skipped: true, condition: node.when, reason },
    summary: `Skipped: ${node.when} was ${reason}`,
    skippedReason: `Condition not met: ${node.when}`,
  });
}

function drySkipped(node: WorkflowNodeDefinition, deps: WorkflowRuntimeDeps, input: unknown, reason: string, attempt = 1): WorkflowNodeRun {
  return makeNodeRun(node, "skipped", deps, { attempt,
    input,
    output: { dryRun: true, skipped: true, reason, plannedAction: input },
    summary: reason,
    skippedReason: reason,
    dryRun: true,
  });
}

function isDryRunSafeTool(deps: WorkflowRuntimeDeps, toolName: string): boolean {
  if (DRY_RUN_SAFE_TOOLS.has(toolName)) return true;
  const tool = deps.toolRegistry.list().find((entry) => entry.schema.name === toolName);
  return tool?.schema.destructive === false && DRY_RUN_SAFE_TOOLS.has(toolName);
}

