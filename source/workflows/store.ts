import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgavDir } from "../config/config.js";
import type { WorkflowNodeRun, WorkflowPendingNode, WorkflowRun, WorkflowRunSummary } from "./types.js";
import { flattenNodes } from "./validator.js";

export interface WorkflowStoreOptions {
  rootDir?: string;
}

const TERMINAL_NODE_STATUSES = new Set(["passed", "failed", "skipped", "cancelled", "timed_out", "waiting_approval"]);

export class WorkflowStore {
  readonly rootDir: string;

  constructor(options: WorkflowStoreOptions = {}) {
    this.rootDir = options.rootDir ?? join(getAgavDir(), "workflow-runs");
  }

  createRunId(): string {
    return `run_${randomUUID().slice(0, 8)}`;
  }

  runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  nodePath(runId: string, nodeId: string): string {
    return join(this.runDir(runId), "nodes", `${safeNodeId(nodeId)}.json`);
  }

  nodeAttemptsDir(runId: string, nodeId: string): string {
    return join(this.runDir(runId), "nodes", `${safeNodeId(nodeId)}.attempts`);
  }

  nodeAttemptPath(runId: string, nodeId: string, attempt: number): string {
    return join(this.nodeAttemptsDir(runId, nodeId), `${attempt}.json`);
  }

  logPath(runId: string, nodeId: string): string {
    return join(this.runDir(runId), "logs", `${safeNodeId(nodeId)}.log`);
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    await writeJsonAtomic(join(this.runDir(run.id), "run.json"), run);
  }

  async loadRun(runId: string): Promise<WorkflowRun | null> {
    return readJson<WorkflowRun>(join(this.runDir(runId), "run.json"));
  }

  async listRuns(): Promise<WorkflowRun[]> {
    if (!existsSync(this.rootDir)) return [];
    const runs: WorkflowRun[] = [];
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const run = await this.loadRun(entry.name);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async getRunSummary(runId: string): Promise<WorkflowRunSummary | null> {
    const run = await this.loadRun(runId);
    if (!run) return null;
    const nodesById = await this.loadNodes(runId);
    const nodes = Object.values(nodesById).sort((a, b) => {
      const aTime = Date.parse(a.startedAt ?? a.endedAt ?? "");
      const bTime = Date.parse(b.startedAt ?? b.endedAt ?? "");
      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return a.id.localeCompare(b.id);
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return aTime - bTime;
    });
    const pendingNodes: WorkflowPendingNode[] = flattenNodes(run.definition.nodes)
      .filter((node) => !nodesById[node.id])
      .map((node) => ({ id: node.id, type: node.type, dependsOn: node.dependsOn }));
    return { run, nodes, pendingNodes };
  }

  async saveNode(runId: string, node: WorkflowNodeRun): Promise<void> {
    await writeJsonAtomic(this.nodePath(runId, node.id), node);
    if (TERMINAL_NODE_STATUSES.has(node.status)) {
      await this.saveNodeAttempt(runId, node);
    }
  }

  async saveNodeAttempt(runId: string, node: WorkflowNodeRun): Promise<void> {
    await writeJsonAtomic(this.nodeAttemptPath(runId, node.id, node.attempt), node);
  }

  async listNodeAttempts(runId: string, nodeId: string): Promise<WorkflowNodeRun[]> {
    const dir = this.nodeAttemptsDir(runId, nodeId);
    if (!existsSync(dir)) return [];
    const attempts: WorkflowNodeRun[] = [];
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".json")) continue;
      const attempt = await readJson<WorkflowNodeRun>(join(dir, entry));
      if (attempt) attempts.push(attempt);
    }
    return attempts.sort((a, b) => a.attempt - b.attempt);
  }

  async nextNodeAttempt(runId: string, nodeId: string): Promise<number> {
    const attempts = await this.listNodeAttempts(runId, nodeId);
    const latestCheckpoint = await this.loadNode(runId, nodeId);
    const maxAttempt = Math.max(0, ...attempts.map((attempt) => attempt.attempt), latestCheckpoint?.attempt ?? 0);
    return maxAttempt + 1;
  }

  async loadNode(runId: string, nodeId: string): Promise<WorkflowNodeRun | null> {
    return readJson<WorkflowNodeRun>(this.nodePath(runId, nodeId));
  }

  async loadNodes(runId: string): Promise<Record<string, WorkflowNodeRun>> {
    const dir = join(this.runDir(runId), "nodes");
    if (!existsSync(dir)) return {};
    const out: Record<string, WorkflowNodeRun> = {};
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".json")) continue;
      const node = await readJson<WorkflowNodeRun>(join(dir, entry));
      if (node) out[node.id] = node;
    }
    return out;
  }

  async appendLog(runId: string, nodeId: string, line: string): Promise<void> {
    const path = this.logPath(runId, nodeId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line + "\n");
  }

  async readLog(runId: string, nodeId: string, limit = 50): Promise<string[]> {
    try {
      const raw = await readFile(this.logPath(runId, nodeId), "utf8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      return limit > 0 ? lines.slice(-limit) : lines;
    } catch {
      return [];
    }
  }

  async readRunLogs(runId: string, limit = 20): Promise<Array<{ nodeId: string; lines: string[] }>> {
    const dir = join(this.runDir(runId), "logs");
    if (!existsSync(dir)) return [];
    const entries = (await readdir(dir)).filter((entry) => entry.endsWith(".log"));
    const out: Array<{ nodeId: string; lines: string[] }> = [];
    for (const entry of entries.sort()) {
      const nodeId = entry.slice(0, -".log".length);
      const lines = await this.readLog(runId, nodeId, limit);
      if (lines.length > 0) out.push({ nodeId, lines });
    }
    return out;
  }
}

/** Monotonic counter guaranteeing a unique temp file per atomic write. */
let atomicWriteSeq = 0;

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${atomicWriteSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  try {
    await rename(tmp, path);
  } catch (error: any) {
    if (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EACCES")) {
      await rm(path, { force: true }).catch(() => {});
      await rename(tmp, path);
      return;
    }
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
