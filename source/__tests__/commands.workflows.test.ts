import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "../workflows/types.js";

const getRunSummary = vi.fn();

vi.mock("../workflows/store.js", () => {
  class MockWorkflowStore {
    async listRuns() { return []; }
    getRunSummary = getRunSummary;
  }
  return { WorkflowStore: MockWorkflowStore };
});

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run_test",
    workflowName: "demo",
    workflowVersion: 1,
    workflowHash: "hash",
    status: "passed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    inputs: {},
    policies: {},
    definition: { version: 1, name: "demo", nodes: [] },
    currentNodeIds: [],
    completedNodeIds: [],
    failedNodeIds: [],
    waitingApprovalNodeIds: [],
    ...overrides,
  };
}

function agentNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "remote_call",
    type: "agent" as const,
    status: "passed" as const,
    attempt: 1,
    nodeHash: "x",
    summary: "done",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("workflows command formatting", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), "agav-workflows-command-"));
    process.chdir(dir);
    getRunSummary.mockReset();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("shows pending nodes in checkpoint output", async () => {
    const { workflowsCommand } = await import("../commands/workflows.js");
    getRunSummary.mockResolvedValue({
      run: makeRun({ status: "failed", failedNodeIds: ["first"] }),
      nodes: [{ id: "first", type: "tool", status: "failed", attempt: 1, nodeHash: "x", error: "bad" }],
      pendingNodes: [{ id: "second", type: "agent", dependsOn: ["first"] }],
    });

    const result = await workflowsCommand.execute("checkpoints run_test", {} as any);
    const text = (result as any).text;

    expect(result).toMatchObject({ type: "message" });
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("pending");
  });

  it("shows a reported external agent budget in checkpoint output", async () => {
    const { workflowsCommand } = await import("../commands/workflows.js");
    getRunSummary.mockResolvedValue({
      run: makeRun(),
      nodes: [agentNode({
        usageReported: true,
        usage: { inputTokens: 120, outputTokens: 40 },
        tokenBudget: { limit: 5000, used: 160, remaining: 4840, period: "run" },
      })],
      pendingNodes: [],
    });

    const result = await workflowsCommand.execute("checkpoints run_test", {} as any);
    const text = (result as any).text;

    expect(text).toContain("limit 5000, used 160, remaining 4840 (run)");
    expect(text).not.toContain("no token budget returned");
  });

  it("highlights an external agent that returned no budget in checkpoint output", async () => {
    const { workflowsCommand } = await import("../commands/workflows.js");
    getRunSummary.mockResolvedValue({
      run: makeRun(),
      nodes: [agentNode({
        usageReported: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })],
      pendingNodes: [],
    });

    const result = await workflowsCommand.execute("checkpoints run_test", {} as any);
    const text = (result as any).text;

    expect(text).toContain("no token budget returned");
  });

  it("warns in status output when an external agent reported nothing", async () => {
    const { workflowsCommand } = await import("../commands/workflows.js");
    getRunSummary.mockResolvedValue({
      run: makeRun(),
      nodes: [agentNode({
        usageReported: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })],
      pendingNodes: [],
    });

    const result = await workflowsCommand.execute("status run_test", {} as any);
    const text = (result as any).text;

    expect(text).toContain("Warning: no token budget returned by external agent(s): remote_call");
    expect(text).toContain("No token budget returned by external agents:");
  });

  it("does not warn in status output when every agent reported a budget", async () => {
    const { workflowsCommand } = await import("../commands/workflows.js");
    getRunSummary.mockResolvedValue({
      run: makeRun(),
      nodes: [agentNode({
        usageReported: true,
        usage: { inputTokens: 120, outputTokens: 40 },
        tokenBudget: { limit: 5000, used: 160, period: "run" },
      })],
      pendingNodes: [],
    });

    const result = await workflowsCommand.execute("status run_test", {} as any);
    const text = (result as any).text;

    expect(text).not.toContain("Warning: no token budget returned");
    expect(text).toContain("External agent budgets:");
    expect(text).toContain("limit 5000, used 160 (run)");
  });

  it("does not flag tool nodes that have no budget concept", async () => {
    const { workflowsCommand } = await import("../commands/workflows.js");
    getRunSummary.mockResolvedValue({
      run: makeRun(),
      nodes: [{
        id: "plain_tool",
        type: "tool",
        status: "passed",
        attempt: 1,
        nodeHash: "x",
        summary: "done",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
      }],
      pendingNodes: [],
    });

    const result = await workflowsCommand.execute("status run_test", {} as any);
    const text = (result as any).text;

    expect(text).not.toContain("no token budget returned");
    expect(text).not.toContain("Warning:");
  });
});
