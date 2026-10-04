import { hashValue } from "./hash.js";
import { computeRunMetrics, type WorkflowRunMetrics } from "./metrics.js";
import { WorkflowStore } from "./store.js";
import type {
  WorkflowApprovalDecision,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowRunStatus,
} from "./types.js";

export async function getWorkflowRunSummary(runId: string, store = new WorkflowStore()) {
  const summary = await store.getRunSummary(runId);
  if (!summary) throw new Error(`Workflow run ${runId} not found`);
  return summary;
}

export async function getWorkflowRunMetrics(
  runId: string,
  store = new WorkflowStore(),
): Promise<WorkflowRunMetrics> {
  const summary = await getWorkflowRunSummary(runId, store);
  return computeRunMetrics(summary);
}

export async function decideWorkflowApproval(
  runId: string,
  nodeId: string,
  decision: WorkflowApprovalDecision,
  store = new WorkflowStore(),
): Promise<WorkflowNodeRun> {
  const run = await loadRequiredRun(store, runId);
  const node = await store.loadNode(runId, nodeId);
  if (!node) throw new Error(`Workflow node ${nodeId} not found in run ${runId}`);
  if (node.type !== "approval") throw new Error(`Workflow node ${nodeId} is not an approval node`);
  if (node.status !== "waiting_approval") throw new Error(`Workflow node ${nodeId} is not waiting for approval`);

  const decidedAt = decision.decidedAt ?? new Date().toISOString();
  const approval = { ...decision, decidedAt };
  const updated: WorkflowNodeRun = {
    ...node,
    status: decision.decision === "approved" ? "passed" : "failed",
    endedAt: decidedAt,
    approval,
    output: approval,
    summary: decision.decision === "approved" ? "Approved" : "Denied",
    error: decision.decision === "denied" ? "Approval denied" : undefined,
  };
  await store.saveNode(runId, updated);

  await refreshRunTerminalState(run, store);
  return updated;
}

export async function cancelWorkflow(
  runId: string,
  reason?: string,
  store = new WorkflowStore(),
): Promise<WorkflowRun> {
  const run = await loadRequiredRun(store, runId);
  run.status = "cancelled";
  run.currentNodeIds = [];
  run.updatedAt = new Date().toISOString();
  run.error = reason ?? "Workflow cancelled by user";
  await store.saveRun(run);
  return run;
}

export async function pauseWorkflow(
  runId: string,
  reason?: string,
  store = new WorkflowStore(),
): Promise<WorkflowRun> {
  const run = await loadRequiredRun(store, runId);
  run.status = "paused";
  run.currentNodeIds = [];
  run.updatedAt = new Date().toISOString();
  run.error = reason ?? "Workflow paused by user";
  await store.saveRun(run);
  return run;
}

export async function retryWorkflowNode(
  runId: string,
  nodeId: string,
  store = new WorkflowStore(),
): Promise<WorkflowRun> {
  const run = await loadRequiredRun(store, runId);
  const nodeIdsToInvalidate = downstreamNodeIds(run, nodeId);
  const checkpoints = await store.loadNodes(runId);
  for (const id of nodeIdsToInvalidate) {
    const checkpoint = checkpoints[id];
    if (!checkpoint) continue;
    await store.saveNode(runId, {
      ...checkpoint,
      status: "pending",
      endedAt: undefined,
      error: undefined,
      skippedReason: `Invalidated for retry from ${nodeId}`,
    });
  }
  run.status = "pending";
  run.currentNodeIds = [];
  run.failedNodeIds = run.failedNodeIds.filter((id) => !nodeIdsToInvalidate.has(id));
  run.completedNodeIds = run.completedNodeIds.filter((id) => !nodeIdsToInvalidate.has(id));
  run.waitingApprovalNodeIds = run.waitingApprovalNodeIds.filter((id) => !nodeIdsToInvalidate.has(id));
  run.updatedAt = new Date().toISOString();
  await store.saveRun(run);
  return run;
}

async function loadRequiredRun(store: WorkflowStore, runId: string): Promise<WorkflowRun> {
  const run = await store.loadRun(runId);
  if (!run) throw new Error(`Workflow run ${runId} not found`);
  return run;
}

async function refreshRunTerminalState(run: WorkflowRun, store: WorkflowStore): Promise<void> {
  const nodes = await store.loadNodes(run.id);
  run.completedNodeIds = Object.values(nodes).filter((node) => node.status === "passed").map((node) => node.id);
  run.failedNodeIds = Object.values(nodes).filter((node) => node.status === "failed" || node.status === "timed_out").map((node) => node.id);
  run.waitingApprovalNodeIds = Object.values(nodes).filter((node) => node.status === "waiting_approval").map((node) => node.id);
  run.currentNodeIds = [];
  run.status = deriveRunStatus(run);
  run.updatedAt = new Date().toISOString();
  await store.saveRun(run);
}

function deriveRunStatus(run: WorkflowRun): WorkflowRunStatus {
  if (run.waitingApprovalNodeIds.length > 0) return "waiting_approval";
  if (run.failedNodeIds.length > 0) return "failed";
  return "pending";
}

function downstreamNodeIds(run: WorkflowRun, nodeId: string): Set<string> {
  const all = flattenRunNodeRefs(run);
  const knownIds = new Set(all.map((node) => node.id));
  if (!knownIds.has(nodeId)) throw new Error(`Workflow node ${nodeId} not found in run ${run.id}`);

  const invalid = new Set<string>([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of all) {
      if (invalid.has(node.id)) continue;
      if ((node.dependsOn ?? []).some((dep) => invalid.has(dep))) {
        invalid.add(node.id);
        changed = true;
      }
    }
  }
  return invalid;
}

function flattenRunNodeRefs(run: WorkflowRun): Array<{ id: string; dependsOn?: string[]; hash: string }> {
  const out: Array<{ id: string; dependsOn?: string[]; hash: string }> = [];
  const visit = (nodes: typeof run.definition.nodes): void => {
    for (const node of nodes) {
      out.push({ id: node.id, dependsOn: node.dependsOn, hash: hashValue(node) });
      if (node.type === "parallel") visit(node.children);
      if (node.type === "loop") visit(node.body);
    }
  };
  visit(run.definition.nodes);
  return out;
}
