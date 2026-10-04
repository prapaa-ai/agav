import type { CommandContext, CommandResult, SlashCommand } from "./types.js";
import { getAgent, loadAgents } from "../agents/loader.js";
import { executeA2AAgent, executeNativeAgent } from "../agents/executor.js";
import { getSkill } from "../skills/loader.js";
import { executeSkill } from "../skills/executor.js";
import { cancelWorkflow, decideWorkflowApproval, getWorkflowRunMetrics, getWorkflowRunSummary, pauseWorkflow, retryWorkflowNode } from "../workflows/control.js";
import { computeRunMetrics, formatDuration, formatMetrics, nodeDurationMs } from "../workflows/metrics.js";
import { listWorkflows, loadWorkflow } from "../workflows/loader.js";
import { loadWorkflowEvals, runWorkflowEvals } from "../workflows/evals.js";
import { resumeWorkflow, runWorkflow } from "../workflows/runtime.js";
import { validateWorkflow } from "../workflows/validator.js";
import { WorkflowStore } from "../workflows/store.js";
import type { AgentDefinition } from "../agents/types.js";
import type { WorkflowNodeRun, WorkflowPendingNode, WorkflowRun } from "../workflows/types.js";

function short(text: unknown, max = 120): string {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatRun(run: WorkflowRun): string {
  return [
    `Workflow ${run.id} — ${run.workflowName}`,
    `Status: ${run.status}`,
    `Created: ${new Date(run.createdAt).toLocaleString()}`,
    `Updated: ${new Date(run.updatedAt).toLocaleString()}`,
    "",
    `Completed: ${run.completedNodeIds.join(", ") || "none"}`,
    `Waiting approval: ${run.waitingApprovalNodeIds.join(", ") || "none"}`,
    `Failed: ${run.failedNodeIds.join(", ") || "none"}`,
    `Current: ${run.currentNodeIds.join(", ") || "none"}`,
    run.error ? `Error: ${run.error}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatNode(node: WorkflowNodeRun): string {
  const duration = node.startedAt ? formatDuration(nodeDurationMs(node)) : "";
  const meta = [
    duration,
    node.attempt > 1 ? `attempt ${node.attempt}` : "",
    node.usage ? `${(node.usage.inputTokens ?? 0) + (node.usage.outputTokens ?? 0)} tok` : "",
    node.dryRun ? "dry-run" : "",
    node.mocked ? "mocked" : "",
  ].filter(Boolean).join(", ");
  const icon = node.status === "passed" ? "✓" : node.status === "failed" ? "✗" : node.status === "waiting_approval" ? "?" : node.status === "running" ? "…" : "-";
  const detail = node.error ?? node.summary ?? short(node.output);
  return `  ${icon} ${node.id.padEnd(20)} ${node.type.padEnd(9)} ${node.status.padEnd(16)} ${short(detail, 60).padEnd(60)} ${meta}`;
}

function formatPending(node: WorkflowPendingNode): string {
  const deps = node.dependsOn?.length ? `depends on ${node.dependsOn.join(", ")}` : "pending";
  return `  - ${node.id.padEnd(20)} ${node.type.padEnd(9)} ${"pending".padEnd(16)} ${deps}`;
}

async function ensureAgentsLoaded(): Promise<void> {
  if (getAgent("__never__")) return;
  await loadAgents().catch(() => []);
}

async function executeWorkflowAgent(agent: AgentDefinition, task: string, context: CommandContext, signal?: AbortSignal, idempotencyKey?: string): Promise<string> {
  if (agent.manifest.type === "a2a") return executeA2AAgent(agent, task, { signal, context: idempotencyKey ? { idempotencyKey } : undefined });
  if (!context.provider) throw new Error("Cannot run native agent workflow without an active provider");
  return executeNativeAgent(agent, task, {
    provider: context.provider,
    config: context.config,
    signal,
  });
}

async function runtimeDeps(context: CommandContext, store: WorkflowStore) {
  if (!context.provider) throw new Error("Cannot run workflow without an active provider");
  await ensureAgentsLoaded();
  return {
    provider: context.provider,
    config: context.config,
    toolRegistry: context.toolRegistry,
    store,
    loadAgent: async (name: string) => getAgent(name) ?? null,
    executeAgent: async (agent: AgentDefinition, task: string, options: { signal?: AbortSignal; idempotencyKey?: string }) => executeWorkflowAgent(agent, task, context, options.signal, options.idempotencyKey),
    executeSkill: async (name: string, args: string, options: { model?: string; effort?: typeof context.config.effort; permissionMode?: typeof context.config.permissionMode }) => {
      const skill = getSkill(name);
      if (!skill) throw new Error(`Skill "${name}" not found`);
      const result = await executeSkill(skill, args, {
        provider: context.provider!,
        parentRegistry: context.toolRegistry,
        model: options.model ?? context.config.model,
        systemPrompt: context.config.systemPrompt ?? "",
        permissionMode: options.permissionMode ?? context.config.permissionMode,
        effort: options.effort ?? context.config.effort,
        maxIterations: context.config.maxIterations,
      });
      return result.output;
    },
  };
}

export const workflowsCommand: SlashCommand = {
  name: "workflows",
  description: "Run, inspect, approve, cancel, and resume workflow runs",
  usage: `Usage: /workflows <action>

  /workflows list                         List workflow definitions
  /workflows runs                         List workflow runs
  /workflows validate <workflow>          Validate a workflow file/name
  /workflows run <workflow>               Run a workflow
  /workflows dry-run <workflow>           Run without external side effects
  /workflows test <workflow>              Run workflow eval fixtures
  /workflows status <run-id>              Show a run summary with metrics
  /workflows metrics <run-id>             Show detailed run metrics
  /workflows logs <run-id> [node-id]     Show recent node logs
  /workflows checkpoints <run-id>         Show node checkpoints and pending nodes
  /workflows attempts <run-id> <node-id>  Show attempt history for a node
  /workflows approve <run-id> <node-id>   Approve a waiting approval node
  /workflows deny <run-id> <node-id>      Deny a waiting approval node
  /workflows pause <run-id>               Mark a run paused
  /workflows cancel <run-id>              Mark a run cancelled
  /workflows retry <run-id> <node-id>     Reset node and downstream checkpoints
  /workflows resume <run-id>              Resume a run from checkpoints`,
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const [actionRaw, runId, nodeId, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const action = actionRaw ?? "runs";
    const store = new WorkflowStore();

    try {
      if (action === "list") {
        const workflows = await listWorkflows();
        if (workflows.length === 0) return { type: "message", text: "No workflows found." };
        return { type: "message", text: workflows.map((wf) => `${wf.definition.name} — ${wf.definition.description ?? wf.path}`).join("\n") };
      }

      if (action === "runs") {
        const runs = await store.listRuns();
        if (runs.length === 0) return { type: "message", text: "No workflow runs found." };
        const lines = await Promise.all(runs.map(async (run) => {
          const summary = await store.getRunSummary(run.id);
          const metrics = summary ? computeRunMetrics(summary) : undefined;
          const progress = metrics ? `${metrics.completedNodes}/${metrics.nodeCount + metrics.pendingNodes} done` : "";
          const duration = metrics ? formatDuration(metrics.durationMs) : "";
          return `  ${run.id}  [${run.status}]  ${run.workflowName}  ${progress.padEnd(14)} ${duration.padStart(8)}  ${new Date(run.updatedAt).toLocaleString()}`;
        }));
        return { type: "message", text: `Workflow runs:\n${lines.join("\n")}` };
      }

      if (action === "validate") {
        if (!runId) return { type: "message", text: "Usage: /workflows validate <workflow>" };
        const loaded = await loadWorkflow(runId);
        const deps = await runtimeDeps(context, store);
        const result = await validateWorkflow(loaded.definition, {
          hasTool: (name) => deps.toolRegistry.list().some((tool) => tool.schema.name === name),
          hasAgent: async (name) => Boolean(await deps.loadAgent(name)),
          hasSkill: (name) => Boolean(getSkill(name)),
        });
        if (result.ok) return { type: "message", text: `Workflow valid: ${loaded.definition.name}` };
        return { type: "message", text: `Workflow validation failed:\n${result.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}` };
      }

      if (action === "run" || action === "dry-run") {
        if (!runId) return { type: "message", text: `Usage: /workflows ${action} <workflow>` };
        const loaded = await loadWorkflow(runId);
        const run = await runWorkflow(loaded.definition, {}, await runtimeDeps(context, store), { dryRun: action === "dry-run" });
        return { type: "message", text: `Workflow ${run.id} ${action === "dry-run" ? "dry-ran" : "started"}.\n\n${formatRun(run)}` };
      }

      if (action === "test") {
        if (!runId) return { type: "message", text: "Usage: /workflows test <workflow>" };
        const loaded = await loadWorkflow(runId);
        const fixtures = await loadWorkflowEvals(loaded.path);
        if (fixtures.length === 0) return { type: "message", text: `No eval fixtures found for ${loaded.definition.name}.` };
        const summary = await runWorkflowEvals(loaded.definition, fixtures, await runtimeDeps(context, store));
        const lines = summary.results.map((result) => `${result.passed ? "✓" : "✗"} ${result.name} (${result.runId})${result.failures.length ? ": " + result.failures.join("; ") : ""}`);
        return { type: "message", text: `${lines.join("\n")}\n${summary.passedCount}/${summary.total} evals passed` };
      }

      if (!runId) return { type: "message", text: `Usage: /workflows ${action} <run-id>` };

      if (action === "status") {
        const summary = await getWorkflowRunSummary(runId, store);
        return { type: "message", text: `${formatRun(summary.run)}

${formatMetrics(computeRunMetrics(summary))}` };
      }

      if (action === "metrics") {
        return { type: "message", text: formatMetrics(await getWorkflowRunMetrics(runId, store)) };
      }

      if (action === "logs") {
        if (nodeId) {
          const lines = await store.readLog(runId, nodeId, 100);
          if (lines.length === 0) return { type: "message", text: `No logs for ${nodeId} in ${runId}.` };
          return { type: "message", text: lines.join("\n") };
        }
        const all = await store.readRunLogs(runId, 20);
        if (all.length === 0) return { type: "message", text: `No logs found for ${runId}.` };
        return { type: "message", text: all.map((entry) => `--- ${entry.nodeId} ---\n${entry.lines.join("\n")}`).join("\n") };
      }

      if (action === "checkpoints" || action === "nodes") {
        const { nodes, pendingNodes } = await getWorkflowRunSummary(runId, store);
        const lines = [...nodes.map(formatNode), ...pendingNodes.map(formatPending)];
        if (lines.length === 0) return { type: "message", text: `No checkpoint or pending node state found for ${runId}.` };
        return { type: "message", text: `Node checkpoints for ${runId}:\n${lines.join("\n")}` };
      }

      if (action === "attempts") {
        if (!nodeId) return { type: "message", text: "Usage: /workflows attempts <run-id> <node-id>" };
        const attempts = await store.listNodeAttempts(runId, nodeId);
        if (attempts.length === 0) return { type: "message", text: `No attempts found for ${nodeId} in ${runId}.` };
        return { type: "message", text: `Attempts for ${nodeId} in ${runId}:\n${attempts.map(formatNode).join("\n")}` };
      }

      if (action === "approve" || action === "deny") {
        if (!nodeId) return { type: "message", text: `Usage: /workflows ${action} <run-id> <node-id>` };
        const note = rest.join(" ") || undefined;
        const node = await decideWorkflowApproval(runId, nodeId, {
          decision: action === "approve" ? "approved" : "denied",
          approvedBy: "local-user",
          note,
        }, store);
        return { type: "message", text: `${action === "approve" ? "Approved" : "Denied"} ${node.id} for ${runId}.` };
      }

      if (action === "pause") {
        const run = await pauseWorkflow(runId, rest.join(" ") || undefined, store);
        return { type: "message", text: `Paused ${run.id}.` };
      }

      if (action === "cancel") {
        const run = await cancelWorkflow(runId, rest.join(" ") || undefined, store);
        return { type: "message", text: `Cancelled ${run.id}.` };
      }

      if (action === "retry" || action === "rewind") {
        if (!nodeId) return { type: "message", text: `Usage: /workflows ${action} <run-id> <node-id>` };
        const run = await retryWorkflowNode(runId, nodeId, store);
        return { type: "message", text: `Reset ${nodeId} and downstream checkpoints.\n\n${formatRun(run)}` };
      }

      if (action === "resume") {
        const run = await resumeWorkflow(runId, await runtimeDeps(context, store), { approveRetry: rest.includes("--approve-retry") });
        return { type: "message", text: `Workflow ${run.id} resumed.\n\n${formatRun(run)}` };
      }

      return { type: "message", text: "Unknown workflows action. Use /help workflows." };
    } catch (error) {
      return { type: "message", text: `Workflow command failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};
