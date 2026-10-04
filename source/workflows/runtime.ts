import { Ajv } from "ajv";
import type { AgentDefinition } from "../agents/types.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop, type ConfirmResult } from "../agent/loop.js";
import type { AgavConfig, EffortLevel, PermissionMode } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { hashValue } from "./hash.js";
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
} from "./types.js";
import { validateWorkflow } from "./validator.js";

const DEFAULT_MAX_CONCURRENCY = 4;
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
  executeAgent: (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string>;
  executeSkill?: (skill: string, args: string, options: AgentExecutionOptions) => Promise<string>;
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
  if (run.status === "paused") run.status = "pending";
  if (run.status === "cancelled" && !options.force) {
    throw new Error(`Workflow run ${runId} is cancelled. Use force to resume it anyway.`);
  }
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

  // Only top-level nodes are scheduled by the run loop. Nested `parallel`
  // children are owned and scheduled by their parent node, so they must not
  // be treated as independent run-level nodes here.
  const allNodes = run.definition.nodes;
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const completedThisRun = new Set<string>();
  const failedThisRun = new Set<string>();
  const waitingThisRun = new Set<string>();
  const skippedThisRun = new Set<string>();

  while (true) {
    if (activeSignal(deps, options)?.aborted) return saveRunStatus(run, store, deps, "paused", "Workflow paused by signal");
    const checkpoints = await store.loadNodes(run.id);
    const ready = allNodes.filter((node) => isReady(node, checkpoints, completedThisRun, failedThisRun, skippedThisRun, nodeById, Boolean(deps.confirm) || Boolean(options.dryRun) || Boolean(options.approveRetry), Boolean(options.dryRun)));

    if (ready.length === 0) {
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

    await Promise.all(batch.map(async (node) => {
      const result = await executeNode(run, node, deps, store, options).catch(async (error: unknown) => {
        const attempt = await store.nextNodeAttempt(run.id, node.id);
        const failed = makeNodeRun(node, "failed", deps, { attempt, error: error instanceof Error ? error.message : String(error) });
        await store.saveNode(run.id, failed);
        return failed;
      });
      if (result.status === "passed") completedThisRun.add(node.id);
      if (result.status === "failed" || result.status === "timed_out") failedThisRun.add(node.id);
      if (result.status === "waiting_approval") waitingThisRun.add(node.id);
      if (result.status === "skipped") skippedThisRun.add(node.id);
    }));

    if (waitingThisRun.size > 0) {
      const terminal = summarizeTerminalState(allNodes, await store.loadNodes(run.id));
      run.completedNodeIds = terminal.completed;
      run.failedNodeIds = terminal.failed;
      run.waitingApprovalNodeIds = terminal.waiting;
      run.currentNodeIds = [];
      return saveRunStatus(run, store, deps, "waiting_approval");
    }

    if ((run.policies.stopOnFailure ?? true) && failedThisRun.size > 0) {
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
  nodeById: Map<string, WorkflowNodeDefinition>,
  canResumeApproval: boolean,
  dryRun: boolean,
): boolean {
  const existing = checkpoints[node.id];
  const hash = hashValue(node);
  if (existing?.status === "passed" && existing.nodeHash === hash) return false;
  if (existing?.status === "skipped" && existing.nodeHash === hash) return false;
  if (existing?.status === "waiting_approval") return canResumeApproval && (node.type === "approval" || existing.output === "retry_approval_required");
  if (existing?.status === "failed" && existing.nodeHash === hash) return false;
  if (completedThisRun.has(node.id) || failedThisRun.has(node.id) || skippedThisRun.has(node.id)) return false;

  for (const depId of node.dependsOn ?? []) {
    const dep = nodeById.get(depId);
    const depCheckpoint = checkpoints[depId];
    const satisfied = depCheckpoint?.status === "passed" || (dryRun && depCheckpoint?.status === "skipped");
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
): Promise<WorkflowNodeRun> {
  const attempt = await store.nextNodeAttempt(run.id, node.id);
  const existing = await store.loadNode(run.id, node.id);
  let currentExisting = existing;
  if (existing?.status === "waiting_approval" && existing.output === "retry_approval_required") {
    if (!options.approveRetry) return existing;
    await store.saveNode(run.id, { ...existing, status: "pending", skippedReason: "Retry approved" });
    currentExisting = { ...existing, status: "pending", skippedReason: "Retry approved" };
  }
  if (shouldRequireRetryApproval(node, currentExisting, options)) {
    const waiting = makeNodeRun(node, "waiting_approval", deps, {
      attempt,
      input: existing?.input,
      output: "retry_approval_required",
      summary: `Retry approval required for ${node.type} node ${node.id}`,
      skippedReason: "retry approval required",
    });
    await store.saveNode(run.id, waiting);
    return waiting;
  }
  if (activeSignal(deps, options)?.aborted) {
    const cancelled = makeNodeRun(node, "cancelled", deps, { attempt, error: "Workflow paused by signal before node execution" });
    await store.saveNode(run.id, cancelled);
    return cancelled;
  }

  const maxAttempts = node.retryPolicy?.maxAttempts;
  if (maxAttempts !== undefined && attempt > maxAttempts) {
    const failed = makeNodeRun(node, "failed", deps, {
      attempt,
      error: `Node exceeded retryPolicy.maxAttempts (${maxAttempts})`,
    });
    await store.saveNode(run.id, failed);
    return failed;
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
        return executeAgentNode(run, node, deps, store, options, attempt);
      case "tool":
        return executeToolNode(run, node, deps, store, options, attempt);
      case "test":
        return executeTestNode(run, node, deps, store, options, attempt);
      case "approval":
        return executeApprovalNode(run, node, deps, store, options, attempt);
      case "prompt":
      case "reduce":
        return executePromptNode(run, node, deps, store, options, attempt);
      case "skill":
        return executeSkillNode(run, node, deps, store, options, attempt);
      case "parallel":
        return executeParallelNode(run, node, deps, store, options, attempt);
      case "loop":
        return executeLoopNode(run, node, deps, store, options, attempt);
      default:
        return makeNodeRun(node, "failed", deps, { attempt, error: `Unsupported node type ${(node as WorkflowNodeDefinition).type}` });
    }
  };

  const result = await withNodeTimeout(executeCurrentNode(), run, node, deps, attempt, options);

  // Preserve the start timestamp captured before execution so metrics and
  // status views report real elapsed time instead of a zero-length window.
  const completed = result.startedAt === started.startedAt ? result : { ...result, startedAt: started.startedAt };

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
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const task = interpolateString(node.task, { inputs: run.inputs, nodes: checkpoints });
  if (options.dryRun) return drySkipped(node, deps, task, `Dry run: skipped agent ${node.agent}`, attempt);
  const agent = await deps.loadAgent(node.agent);
  if (!agent) return makeNodeRun(node, "failed", deps, { attempt, input: task, error: `Unknown agent: ${node.agent}` });

  const output = await deps.executeAgent(agent, task, executionOptions(run, node, deps, options));
  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, { attempt, input: task, output, summary: summarizeOutput(output) }));
}

async function executeToolNode(
  run: WorkflowRun,
  node: WorkflowToolNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
  options: WorkflowRunOptions,
  attempt: number,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const input = interpolateValue(node.input ?? {}, { inputs: run.inputs, nodes: checkpoints }) as Record<string, unknown>;
  if (node.sandbox && input["sandbox"] === undefined) input["sandbox"] = node.sandbox;
  if (options.dryRun && !isDryRunSafeTool(deps, node.tool)) return drySkipped(node, deps, input, `Dry run: skipped tool ${node.tool}`, attempt);
  const result = await deps.toolRegistry.execute(node.tool, input);
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
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const failures: string[] = [];
  const skipped: string[] = [];

  for (const assertion of node.assertions) {
    if (activeSignal(deps, options)?.aborted) return makeNodeRun(node, "cancelled", deps, { attempt, error: "Workflow paused by signal during test node" });
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
): Promise<WorkflowNodeRun> {
  if (!deps.executeSkill) return makeNodeRun(node, "failed", deps, { attempt, error: "No skill executor configured" });
  const checkpoints = await store.loadNodes(run.id);
  const args = interpolateString(node.args ?? "", { inputs: run.inputs, nodes: checkpoints });
  if (options.dryRun) return drySkipped(node, deps, args, `Dry run: skipped skill ${node.skill}`, attempt);
  const output = await deps.executeSkill(node.skill, args, executionOptions(run, node, deps, options));
  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, { attempt, input: args, output, summary: summarizeOutput(output) }));
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

function executionOptions(run: WorkflowRun, node: WorkflowNodeDefinition, deps: WorkflowRuntimeDeps, options: WorkflowRunOptions): AgentExecutionOptions {
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

function summarizeTerminalState(nodes: WorkflowNodeDefinition[], checkpoints: Record<string, WorkflowNodeRun>) {
  return {
    completed: nodes.filter((node) => checkpoints[node.id]?.status === "passed").map((node) => node.id),
    failed: nodes.filter((node) => checkpoints[node.id]?.status === "failed" || checkpoints[node.id]?.status === "timed_out").map((node) => node.id),
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
): Promise<WorkflowNodeRun> {
  const timeoutSeconds = node.timeoutSeconds ?? run.policies.maxNodeRuntimeSeconds;
  if (!timeoutSeconds || timeoutSeconds <= 0) return promise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<WorkflowNodeRun>((resolve) => {
    timeout = setTimeout(() => {
      resolve(makeNodeRun(node, "timed_out", deps, {
        attempt,
        error: `Node timed out after ${timeoutSeconds} seconds`,
        dryRun: options.dryRun === true,
      }));
    }, timeoutSeconds * 1000);
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

function shouldRequireRetryApproval(
  node: WorkflowNodeDefinition,
  existing: WorkflowNodeRun | null,
  options: WorkflowRunOptions,
): boolean {
  if (options.dryRun || !existing || existing.status !== "running") return false;
  if (node.retrySafe === true || node.retryPolicy?.retryRunningAfterCrash === true) return false;
  if (node.retryPolicy?.retryRunningAfterCrash === false || node.retryPolicy?.requireApprovalBeforeRetry) return true;
  return node.type === "agent" || node.type === "tool";
}
