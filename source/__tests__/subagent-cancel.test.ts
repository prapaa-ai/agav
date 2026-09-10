import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock runAgentLoop to return a hanging async generator we can control
vi.mock("../agent/loop.js", () => ({
  runAgentLoop: vi.fn(),
}));

// Mock worktree utilities so we never touch git
vi.mock("../utils/worktree.js", () => ({
  createWorktree: vi.fn(() => Promise.resolve(null)),
  removeWorktree: vi.fn(() => Promise.resolve()),
  applyWorktreeChanges: vi.fn(() => Promise.resolve({ applied: true })),
}));

// Mock steer formatting
vi.mock("../commands/steer.js", () => ({
  formatSteersForPrompt: vi.fn(() => ""),
}));

import { runAgentLoop } from "../agent/loop.js";
import { createSubagentTool } from "../tools/subagent.js";
import { ToolRegistry } from "../tools/registry.js";

/**
 * Create a mock async generator for runAgentLoop that hangs until the
 * provided AbortSignal fires, then yields an error event and returns.
 * This simulates a subagent that is "running" until cancelled.
 */
function makeHangingLoop() {
  return vi.mocked(runAgentLoop).mockImplementation((params: any) => {
    const signal: AbortSignal | undefined = params.signal;
    return (async function* () {
      yield { type: "streaming_text" as const, text: "working..." };
      // Hang until aborted
      if (signal && !signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      yield { type: "assistant_message_complete" as const, text: "aborted" };
    })() as any;
  });
}

function makeDeps(overrides: Partial<Parameters<typeof createSubagentTool>[0]> = {}) {
  return {
    provider: { name: "mock", stream: vi.fn() } as any,
    parentToolRegistry: new ToolRegistry(),
    getConfig: () => ({
      model: "test-model",
      systemPrompt: "You are a test agent.",
      permissionMode: "auto-accept" as const,
      effort: "medium" as const,
      maxIterations: 1,
    }),
    confirmationQueue: { enqueue: vi.fn(() => Promise.resolve("yes")), rejectBySubagentId: vi.fn() } as any,
    onProgressUpdate: vi.fn(),
    onTokenUsage: vi.fn(),
    getSignal: () => undefined,
    ...overrides,
  };
}

describe("subagent per-subagent cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancelSubagent aborts only the targeted subagent", async () => {
    makeHangingLoop();
    const tool = createSubagentTool(makeDeps());

    // Start two subagents — they'll hang until their signals fire
    // Use non-write keywords so worktree logic is skipped
    const p1 = tool.execute({ title: "Agent A", task: "analyze the logs" });
    const p2 = tool.execute({ title: "Agent B", task: "read the config" });

    // Let the hanging generators yield their first event and reach the await
    await vi.advanceTimersByTimeAsync(0);

    // The mock was called twice — extract the signals passed to each call
    expect(vi.mocked(runAgentLoop)).toHaveBeenCalledTimes(2);
    const call1Signal: AbortSignal = vi.mocked(runAgentLoop).mock.calls[0]![0].signal!;
    const call2Signal: AbortSignal = vi.mocked(runAgentLoop).mock.calls[1]![0].signal!;

    // Cancel the first subagent (id is "sa-1" because counter starts at 0 and increments)
    tool.cancelSubagent("sa-1");

    // Let promises settle
    await vi.advanceTimersByTimeAsync(200);

    // First subagent's signal should be aborted
    expect(call1Signal.aborted).toBe(true);
    // Second subagent's signal should NOT be aborted
    expect(call2Signal.aborted).toBe(false);

    // Cancelled subagent should resolve with an error result
    const result1 = await p1;
    expect(result1.isError).toBe(true);
    expect(result1.output).toContain("cancelled");

    // Clean up: cancel the second subagent so its promise resolves
    tool.cancelSubagent("sa-2");
    await vi.advanceTimersByTimeAsync(200);
    await p2;
  });

  it("parent signal abort cascades to all child controllers", async () => {
    makeHangingLoop();
    const parentController = new AbortController();
    const tool = createSubagentTool(
      makeDeps({ getSignal: () => parentController.signal }),
    );

    const p1 = tool.execute({ title: "Agent A", task: "analyze the logs" });
    const p2 = tool.execute({ title: "Agent B", task: "read the config" });

    await vi.advanceTimersByTimeAsync(0);

    const call1Signal: AbortSignal = vi.mocked(runAgentLoop).mock.calls[0]![0].signal!;
    const call2Signal: AbortSignal = vi.mocked(runAgentLoop).mock.calls[1]![0].signal!;

    // Both should be running
    expect(call1Signal.aborted).toBe(false);
    expect(call2Signal.aborted).toBe(false);

    // Abort the parent
    parentController.abort();

    // Let promises settle
    await vi.advanceTimersByTimeAsync(200);

    // Both children should now be aborted
    expect(call1Signal.aborted).toBe(true);
    expect(call2Signal.aborted).toBe(true);

    // Both subagents should resolve as cancelled
    const [result1, result2] = await Promise.all([p1, p2]);
    expect(result1.isError).toBe(true);
    expect(result1.output).toContain("cancelled");
    expect(result2.isError).toBe(true);
    expect(result2.output).toContain("cancelled");
  });

  it("cancelSubagent is a no-op for unknown IDs", () => {
    const tool = createSubagentTool(makeDeps());
    // Should not throw for non-existent IDs
    expect(() => tool.cancelSubagent("sa-999")).not.toThrow();
    expect(() => tool.cancelSubagent("")).not.toThrow();
    expect(() => tool.cancelSubagent("bogus-id")).not.toThrow();
  });
});
