import { readFile } from "node:fs/promises";
import { createToolRegistry } from "../tools/registry-factory.js";
import { loadConfig } from "../config/config.js";
import { createProvider } from "../providers/registry.js";
import { buildSystemPrompt } from "../utils/system-prompt.js";
import { getAgent, loadAgents } from "../agents/loader.js";
import { executeA2AAgent, executeNativeAgent } from "../agents/executor.js";
import { validateWorkflow } from "../workflows/validator.js";
import { listWorkflows, loadWorkflow } from "../workflows/loader.js";
import { runWorkflow, resumeWorkflow } from "../workflows/runtime.js";
import { loadWorkflowEvals, runWorkflowEvals } from "../workflows/evals.js";
import { WorkflowStore } from "../workflows/store.js";
import { cancelWorkflow, decideWorkflowApproval, getWorkflowRunMetrics, getWorkflowRunSummary, pauseWorkflow, retryWorkflowNode } from "../workflows/control.js";
import { computeRunMetrics, formatDuration, formatMetrics, nodeDurationMs } from "../workflows/metrics.js";
import type { AgentDefinition } from "../agents/types.js";
import type { WorkflowDefinition, WorkflowNodeRun, WorkflowPendingNode, WorkflowRun } from "../workflows/types.js";
import { getSkill } from "../skills/loader.js";
import { executeSkill } from "../skills/executor.js";

function printUsage(): void {
  console.log(`Usage: agav workflows <action>

  list                              List workflow definitions
  runs                              List workflow runs
  validate <workflow>               Validate a workflow file/name
  run <workflow> [--input file]      Run a workflow
  dry-run <workflow> [--input file]  Run without external side effects
  test <workflow> [--eval name]      Run workflow eval fixtures
  resume <run-id>                   Resume a workflow run
  status <run-id>                   Show run status with metrics
  metrics <run-id>                  Show detailed run metrics
  logs <run-id> [node-id]           Show recent node logs
  checkpoints <run-id>              Show node checkpoints and pending nodes
  attempts <run-id> <node-id>       Show attempt history for a node
  approve <run-id> <node-id>        Approve a waiting approval node
  deny <run-id> <node-id>           Deny a waiting approval node
  pause <run-id>                    Mark a run paused
  cancel <run-id>                   Mark a run cancelled
  retry <run-id> <node-id>          Reset node and downstream checkpoints
`);
}

function parseInputPath(args: string[]): string | undefined {
  const idx = args.indexOf("--input");
  if (idx >= 0) return args[idx + 1];
  const eq = args.find((arg) => arg.startsWith("--input="));
  return eq?.slice("--input=".length);
}

function parseEvalName(args: string[]): string | undefined {
  const idx = args.indexOf("--eval");
  if (idx >= 0) return args[idx + 1];
  const eq = args.find((arg) => arg.startsWith("--eval="));
  return eq?.slice("--eval=".length);
}

async function readInputs(args: string[]): Promise<Record<string, unknown>> {
  const path = parseInputPath(args);
  if (!path) return {};
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function makeRuntimeDeps() {
  const config = await loadConfig();
  if (!config.systemPrompt) config.systemPrompt = await buildSystemPrompt();
  const provider = createProvider(config);
  const toolRegistry = createToolRegistry();
  await loadAgents();
  return {
    provider,
    config,
    toolRegistry,
    loadAgent: async (name: string) => getAgent(name) ?? null,
    executeAgent: async (agent: AgentDefinition, task: string, execOptions: { signal?: AbortSignal; idempotencyKey?: string }) => {
      const context = execOptions.idempotencyKey ? { idempotencyKey: execOptions.idempotencyKey } : undefined;
      if (agent.manifest.type === "a2a") return executeA2AAgent(agent, task, { signal: execOptions.signal, context });
      return executeNativeAgent(agent, task, { provider, config, signal: execOptions.signal });
    },
    executeSkill: async (name: string, args: string, options: { model?: string; effort?: typeof config.effort; permissionMode?: typeof config.permissionMode }) => {
      const skill = getSkill(name);
      if (!skill) throw new Error(`Skill "${name}" not found`);
      const result = await executeSkill(skill, args, {
        provider,
        parentRegistry: toolRegistry,
        model: options.model ?? config.model,
        systemPrompt: config.systemPrompt ?? "",
        permissionMode: options.permissionMode ?? config.permissionMode,
        effort: options.effort ?? config.effort,
        maxIterations: config.maxIterations,
      });
      return result.output;
    },
  };
}

function formatRun(run: WorkflowRun): string {
  return [
    `Workflow ${run.id} — ${run.workflowName}`,
    `Status: ${run.status}`,
    `Created: ${new Date(run.createdAt).toLocaleString()}`,
    `Updated: ${new Date(run.updatedAt).toLocaleString()}`,
    `Completed: ${run.completedNodeIds.join(", ") || "none"}`,
    `Waiting approval: ${run.waitingApprovalNodeIds.join(", ") || "none"}`,
    `Failed: ${run.failedNodeIds.join(", ") || "none"}`,
    `Current: ${run.currentNodeIds.join(", ") || "none"}`,
    run.error ? `Error: ${run.error}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatNode(node: WorkflowNodeRun): string {
  const icon = node.status === "passed" ? "✓" : node.status === "failed" ? "✗" : node.status === "waiting_approval" ? "?" : node.status === "running" ? "…" : "-";
  const detail = node.error ?? node.summary ?? "";
  const duration = node.startedAt ? formatDuration(nodeDurationMs(node)) : "";
  const meta = [
    duration,
    node.attempt > 1 ? `attempt ${node.attempt}` : "",
    node.usage ? `${(node.usage.inputTokens ?? 0) + (node.usage.outputTokens ?? 0)} tok` : "",
    node.dryRun ? "dry-run" : "",
    node.mocked ? "mocked" : "",
  ].filter(Boolean).join(", ");
  return `  ${icon} ${node.id.padEnd(20)} ${node.type.padEnd(9)} ${node.status.padEnd(16)} ${String(detail).slice(0, 60).padEnd(60)} ${meta}`;
}

function formatPending(node: WorkflowPendingNode): string {
  const deps = node.dependsOn?.length ? `depends on ${node.dependsOn.join(", ")}` : "pending";
  return `  - ${node.id.padEnd(20)} ${node.type.padEnd(9)} ${"pending".padEnd(16)} ${deps}`;
}

async function validateLoaded(definition: WorkflowDefinition): Promise<number> {
  const deps = await makeRuntimeDeps();
  const result = await validateWorkflow(definition, {
    hasTool: (name) => deps.toolRegistry.list().some((tool) => tool.schema.name === name),
    hasAgent: async (name) => Boolean(await deps.loadAgent(name)),
    hasSkill: (name) => Boolean(getSkill(name)),
  });
  if (result.ok) {
    console.log("✓ Workflow valid");
    return 0;
  }
  console.error("Workflow validation failed:");
  for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message}`);
  return 1;
}

export async function runWorkflowsCommand(command: string | undefined, args: string[]): Promise<number> {
  const store = new WorkflowStore();
  try {
    if (!command || command === "help") {
      printUsage();
      return 0;
    }

    if (command === "list") {
      const workflows = await listWorkflows();
      if (workflows.length === 0) console.log("No workflows found.");
      else for (const wf of workflows) console.log(`${wf.definition.name}\t${wf.path}\t${wf.definition.description ?? ""}`);
      return 0;
    }

    if (command === "runs") {
      const runs = await store.listRuns();
      if (runs.length === 0) console.log("No workflow runs found.");
      else {
        for (const run of runs) {
          const summary = await store.getRunSummary(run.id);
          const metrics = summary ? computeRunMetrics(summary) : undefined;
          const progress = metrics ? `${metrics.completedNodes}/${metrics.nodeCount + metrics.pendingNodes} done` : "";
          const duration = metrics ? formatDuration(metrics.durationMs) : "";
          console.log([run.id, run.status, run.workflowName, progress, duration, new Date(run.updatedAt).toLocaleString()].join("  "));
        }
      }
      return 0;
    }

    if (command === "validate") {
      const target = args[0];
      if (!target) { printUsage(); return 1; }
      const loaded = await loadWorkflow(target);
      return validateLoaded(loaded.definition);
    }

    if (command === "run" || command === "dry-run") {
      const target = args[0];
      if (!target) { printUsage(); return 1; }
      const loaded = await loadWorkflow(target);
      const valid = await validateLoaded(loaded.definition);
      if (valid !== 0) return valid;
      const deps = await makeRuntimeDeps();
      const run = await runWorkflow(loaded.definition, await readInputs(args.slice(1)), { ...deps, store }, { dryRun: command === "dry-run" });
      console.log(formatRun(run));
      return run.status === "passed" || run.status === "waiting_approval" ? 0 : 1;
    }

    if (command === "test") {
      const target = args[0];
      if (!target) { printUsage(); return 1; }
      const loaded = await loadWorkflow(target);
      let fixtures = await loadWorkflowEvals(loaded.path);
      const evalName = parseEvalName(args.slice(1));
      if (evalName) fixtures = fixtures.filter((fixture) => fixture.name === evalName);
      if (fixtures.length === 0) {
        console.error(evalName ? `No eval fixture named ${evalName}.` : `No eval fixtures found for ${loaded.definition.name}.`);
        return 1;
      }
      const deps = await makeRuntimeDeps();
      const summary = await runWorkflowEvals(loaded.definition, fixtures, { ...deps, store });
      for (const result of summary.results) {
        console.log(`${result.passed ? "✓" : "✗"} ${result.name} (${result.runId})${result.failures.length ? ": " + result.failures.join("; ") : ""}`);
      }
      console.log(`${summary.passedCount}/${summary.total} evals passed`);
      return summary.passed ? 0 : 1;
    }

    if (command === "resume") {
      const id = args[0];
      if (!id) { printUsage(); return 1; }
      const deps = await makeRuntimeDeps();
      const run = await resumeWorkflow(id, { ...deps, store }, { approveRetry: args.includes("--approve-retry") });
      console.log(formatRun(run));
      return run.status === "passed" || run.status === "waiting_approval" ? 0 : 1;
    }

    if (command === "status") {
      const id = args[0];
      if (!id) { printUsage(); return 1; }
      const summary = await getWorkflowRunSummary(id, store);
      console.log(formatRun(summary.run));
      console.log("");
      console.log(formatMetrics(computeRunMetrics(summary)));
      return 0;
    }

    if (command === "metrics") {
      const id = args[0];
      if (!id) { printUsage(); return 1; }
      console.log(formatMetrics(await getWorkflowRunMetrics(id, store)));
      return 0;
    }

    if (command === "logs") {
      const [id, nodeId] = args;
      if (!id) { printUsage(); return 1; }
      if (nodeId) {
        const lines = await store.readLog(id, nodeId, 100);
        if (lines.length === 0) console.log(`No logs for ${nodeId} in ${id}.`);
        else for (const line of lines) console.log(line);
        return 0;
      }
      const all = await store.readRunLogs(id, 20);
      if (all.length === 0) console.log(`No logs found for ${id}.`);
      for (const entry of all) {
        console.log(`--- ${entry.nodeId} ---`);
        for (const line of entry.lines) console.log(line);
      }
      return 0;
    }

    if (command === "checkpoints") {
      const id = args[0];
      if (!id) { printUsage(); return 1; }
      const summary = await getWorkflowRunSummary(id, store);
      console.log(`Node checkpoints for ${id}:`);
      for (const node of summary.nodes) console.log(formatNode(node));
      for (const node of summary.pendingNodes) console.log(formatPending(node));
      return 0;
    }

    if (command === "attempts") {
      const [id, nodeId] = args;
      if (!id || !nodeId) { printUsage(); return 1; }
      const attempts = await store.listNodeAttempts(id, nodeId);
      if (attempts.length === 0) console.log(`No attempts found for ${nodeId} in ${id}.`);
      else for (const attempt of attempts) console.log(formatNode(attempt));
      return 0;
    }

    if (command === "approve" || command === "deny") {
      const [id, nodeId] = args;
      if (!id || !nodeId) { printUsage(); return 1; }
      await decideWorkflowApproval(id, nodeId, { decision: command === "approve" ? "approved" : "denied", approvedBy: "cli" }, store);
      console.log(`${command === "approve" ? "Approved" : "Denied"} ${nodeId} for ${id}.`);
      return 0;
    }

    if (command === "pause" || command === "cancel") {
      const id = args[0];
      if (!id) { printUsage(); return 1; }
      const run = command === "pause" ? await pauseWorkflow(id, args.slice(1).join(" ") || undefined, store) : await cancelWorkflow(id, args.slice(1).join(" ") || undefined, store);
      console.log(formatRun(run));
      return 0;
    }

    if (command === "retry" || command === "rewind") {
      const [id, nodeId] = args;
      if (!id || !nodeId) { printUsage(); return 1; }
      const run = await retryWorkflowNode(id, nodeId, store);
      console.log(formatRun(run));
      return 0;
    }

    printUsage();
    return 1;
  } catch (error) {
    console.error(`Workflow command failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
