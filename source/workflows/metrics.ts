import type { WorkflowNodeRun, WorkflowNodeStatus, WorkflowNodeType, WorkflowRunSummary } from "./types.js";

export interface WorkflowNodeTypeMetric {
  type: WorkflowNodeType;
  count: number;
  durationMs: number;
  failed: number;
}

export interface WorkflowRetryMetric {
  nodeId: string;
  attempts: number;
}

export interface WorkflowRunMetrics {
  runId: string;
  workflowName: string;
  status: string;
  durationMs: number;
  nodeCount: number;
  completedNodes: number;
  failedNodes: number;
  waitingApprovalNodes: number;
  pendingNodes: number;
  skippedNodes: number;
  runningNodes: number;
  timedOutNodes: number;
  cancelledNodes: number;
  dryRunNodes: number;
  mockedNodes: number;
  totalAttempts: number;
  maxAttempts: number;
  retriedNodes: WorkflowRetryMetric[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  byType: WorkflowNodeTypeMetric[];
  slowestNodes: Array<{ id: string; durationMs: number }>;
}

export function computeRunMetrics(summary: WorkflowRunSummary, now = new Date()): WorkflowRunMetrics {
  const { run, nodes, pendingNodes } = summary;

  const byStatus = new Map<WorkflowNodeStatus, number>();
  for (const node of nodes) byStatus.set(node.status, (byStatus.get(node.status) ?? 0) + 1);

  const typeMap = new Map<WorkflowNodeType, WorkflowNodeTypeMetric>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalAttempts = 0;
  let maxAttempts = 0;
  let dryRunNodes = 0;
  let mockedNodes = 0;
  const retriedNodes: WorkflowRetryMetric[] = [];
  const durations: Array<{ id: string; durationMs: number }> = [];

  for (const node of nodes) {
    const durationMs = nodeDurationMs(node, now);
    durations.push({ id: node.id, durationMs });

    const metric = typeMap.get(node.type) ?? { type: node.type, count: 0, durationMs: 0, failed: 0 };
    metric.count += 1;
    metric.durationMs += durationMs;
    if (node.status === "failed" || node.status === "timed_out") metric.failed += 1;
    typeMap.set(node.type, metric);

    inputTokens += node.usage?.inputTokens ?? 0;
    outputTokens += node.usage?.outputTokens ?? 0;
    cacheReadTokens += node.usage?.cacheReadTokens ?? 0;
    cacheWriteTokens += node.usage?.cacheWriteTokens ?? 0;

    totalAttempts += node.attempt;
    if (node.attempt > maxAttempts) maxAttempts = node.attempt;
    if (node.attempt > 1) retriedNodes.push({ nodeId: node.id, attempts: node.attempt });

    if (node.dryRun) dryRunNodes += 1;
    if (node.mocked) mockedNodes += 1;
  }

  return {
    runId: run.id,
    workflowName: run.workflowName,
    status: run.status,
    durationMs: runDurationMs(run.createdAt, run.updatedAt, now),
    nodeCount: nodes.length,
    completedNodes: byStatus.get("passed") ?? 0,
    failedNodes: (byStatus.get("failed") ?? 0) + (byStatus.get("timed_out") ?? 0),
    waitingApprovalNodes: byStatus.get("waiting_approval") ?? 0,
    pendingNodes: pendingNodes.length,
    skippedNodes: byStatus.get("skipped") ?? 0,
    runningNodes: byStatus.get("running") ?? 0,
    timedOutNodes: byStatus.get("timed_out") ?? 0,
    cancelledNodes: byStatus.get("cancelled") ?? 0,
    dryRunNodes,
    mockedNodes,
    totalAttempts,
    maxAttempts,
    retriedNodes: retriedNodes.sort((a, b) => b.attempts - a.attempts),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    byType: [...typeMap.values()].sort((a, b) => b.durationMs - a.durationMs),
    slowestNodes: durations.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
  };
}

export function nodeDurationMs(node: WorkflowNodeRun, now = new Date()): number {
  const start = Date.parse(node.startedAt ?? "");
  if (Number.isNaN(start)) return 0;
  const end = node.endedAt ? Date.parse(node.endedAt) : now.getTime();
  if (Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

function runDurationMs(createdAt: string, updatedAt: string, now: Date): number {
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) return 0;
  const end = Date.parse(updatedAt);
  const resolved = Number.isNaN(end) ? now.getTime() : end;
  return Math.max(0, resolved - start);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatMetrics(metrics: WorkflowRunMetrics): string {
  const lines: string[] = [
    `Metrics for ${metrics.runId} — ${metrics.workflowName}`,
    `Status: ${metrics.status}`,
    `Duration: ${formatDuration(metrics.durationMs)}`,
    "",
    `Nodes: ${metrics.nodeCount} total` +
      ` | ${metrics.completedNodes} passed` +
      ` | ${metrics.failedNodes} failed` +
      ` | ${metrics.waitingApprovalNodes} waiting` +
      ` | ${metrics.pendingNodes} pending`,
  ];

  if (metrics.skippedNodes > 0 || metrics.dryRunNodes > 0 || metrics.mockedNodes > 0) {
    lines.push(
      `Flags: ${metrics.skippedNodes} skipped | ${metrics.dryRunNodes} dry-run | ${metrics.mockedNodes} mocked`,
    );
  }

  if (metrics.timedOutNodes > 0) lines.push(`Timed out: ${metrics.timedOutNodes}`);
  if (metrics.cancelledNodes > 0) lines.push(`Cancelled: ${metrics.cancelledNodes}`);

  lines.push(
    "",
    `Tokens: ${metrics.totalTokens} total (${metrics.inputTokens} in / ${metrics.outputTokens} out)` +
      (metrics.cacheReadTokens > 0 ? ` | ${metrics.cacheReadTokens} cache read` : ""),
  );

  lines.push(
    "",
    `Attempts: ${metrics.totalAttempts} total | max ${metrics.maxAttempts}` +
      (metrics.retriedNodes.length > 0
        ? ` | retried: ${metrics.retriedNodes.map((entry) => `${entry.nodeId} (${entry.attempts})`).join(", ")}`
        : ""),
  );

  if (metrics.byType.length > 0) {
    lines.push("", "By node type:");
    for (const entry of metrics.byType) {
      lines.push(
        `  ${entry.type.padEnd(12)} ${String(entry.count).padStart(3)} node(s)  ${formatDuration(entry.durationMs).padStart(9)}` +
          (entry.failed > 0 ? `  ${entry.failed} failed` : ""),
      );
    }
  }

  if (metrics.slowestNodes.length > 0) {
    lines.push("", "Slowest nodes:");
    for (const entry of metrics.slowestNodes) {
      lines.push(`  ${entry.id.padEnd(24)} ${formatDuration(entry.durationMs)}`);
    }
  }

  return lines.join("\n");
}
