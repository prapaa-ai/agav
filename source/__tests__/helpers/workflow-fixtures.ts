import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgavConfig } from "../../config/config.js";
import type { JobSummary, StartJobRequest, LogTail } from "../../background-jobs/types.js";
import { createBuiltinToolRegistry } from "../../tools/registry-factory.js";
import type { ToolResult } from "../../tools/types.js";
import { WORKFLOW_TOOLS, type WorkflowDefinition } from "../../workflows/definition.js";
import type { WorkflowExecutionHost } from "../../workflows/gated-tools.js";
import type { JobCoordinatorLike, JobNodeDeps } from "../../workflows/job-node.js";
import { WorkflowStore } from "../../workflows/store.js";

export const registry = createBuiltinToolRegistry(WORKFLOW_TOOLS);

export function testConfig(overrides: Partial<AgavConfig> = {}): AgavConfig {
  return { permissionMode: "auto-accept", backgroundJobsEnabled: true, workflowsEnabled: true, ...overrides } as AgavConfig;
}

export async function tempStore(): Promise<{ store: WorkflowStore; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "agav-wf-test-"));
  return { store: new WorkflowStore(join(root, "workflow-runs")), root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function def(nodes: WorkflowDefinition["nodes"], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { version: 1, name: "test", ...extra, nodes };
}

/** Host whose tools never touch the real filesystem; records every execution. */
export function fakeHost(outputs: Record<string, ToolResult | ((input: Record<string, unknown>) => ToolResult | Promise<ToolResult>)> = {}, confirm = true): WorkflowExecutionHost & { calls: Array<{ name: string; input: Record<string, unknown> }> } {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    confirmTool: async () => confirm,
    executeTool: async (_registry, name, input) => {
      calls.push({ name, input });
      const out = outputs[name];
      if (typeof out === "function") return out(input);
      return out ?? { output: `${name} ok`, isError: false };
    },
  };
}

export function summary(requestId: string, jobId: string, state: JobSummary["state"], exitCode?: number | null): JobSummary {
  return { jobId, requestId, state, stopState: "none", ...(exitCode === undefined ? {} : { exitCode }) };
}

/** In-memory coordinator; `script` maps a jobId to the sequence of states its polls return. */
export class FakeCoordinator implements JobCoordinatorLike {
  readonly starts: StartJobRequest[] = [];
  readonly stops: string[] = [];
  readonly jobs = new Map<string, JobSummary>();
  stdout = "job-output";
  /** States returned by successive polls (last one repeats). */
  pollStates: JobSummary["state"][] = ["completed"];
  private polls = 0;
  async start(request: StartJobRequest): Promise<JobSummary> {
    this.starts.push(request);
    const job = summary(request.requestId, `job-${this.starts.length}`, "running");
    this.jobs.set(job.jobId, job);
    return job;
  }
  async poll(jobId: string): Promise<JobSummary> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    const state = this.pollStates[Math.min(this.polls++, this.pollStates.length - 1)]!;
    const next = { ...job, state, ...(state === "completed" ? { exitCode: 0 } : {}) };
    this.jobs.set(jobId, next);
    return next;
  }
  async log(): Promise<LogTail> { return { text: this.stdout, truncated: false, cursor: "0" }; }
  async stop(jobId: string): Promise<JobSummary> {
    this.stops.push(jobId);
    const job = { ...this.jobs.get(jobId)!, state: "interrupted" as const };
    this.jobs.set(jobId, job);
    this.pollStates = ["interrupted"];
    return job;
  }
  async findByRequestId(requestId: string): Promise<JobSummary | undefined> {
    return [...this.jobs.values()].find(job => job.requestId === requestId);
  }
}

export function jobDeps(coordinator: JobCoordinatorLike, overrides: Partial<JobNodeDeps> = {}): JobNodeDeps {
  return {
    getCoordinator: async () => coordinator,
    session: { permissionMode: "auto-accept", headlessApprovedActions: ["start", "stop"] },
    sandboxRequired: false,
    headless: false,
    pollIntervalMs: 5,
    stopSettleMs: 200,
    ...overrides,
  };
}
