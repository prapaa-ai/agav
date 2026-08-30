import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeAgentProgressTracker } from "../agent/subagent-progress.js";
import type { SubagentProgress } from "../agent/subagent-types.js";
import type { AgentEvent } from "../agent/loop.js";

describe("makeAgentProgressTracker throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid streaming_text events into a single setState call", () => {
    let state: SubagentProgress[] = [];
    const setState = vi.fn((updater: (prev: SubagentProgress[]) => SubagentProgress[]) => {
      state = updater(state);
    });

    const onEvent = makeAgentProgressTracker("sa-1", "Test Agent", "do stuff", setState);

    // The seed() call fires one setState immediately.
    onEvent({ type: "streaming_text", text: "Hello" } as AgentEvent);
    const seedCalls = setState.mock.calls.length; // 1 for seed + 0 for throttled update

    // Fire 50 more streaming_text events rapidly.
    for (let i = 0; i < 50; i++) {
      onEvent({ type: "streaming_text", text: "." } as AgentEvent);
    }

    // Before the timer fires, no additional setState calls for the streaming events.
    const callsBeforeFlush = setState.mock.calls.length;
    expect(callsBeforeFlush).toBe(seedCalls); // only the seed call

    // Advance the timer to trigger the flush.
    vi.advanceTimersByTime(70);

    // Now exactly one more setState call should have been made (the coalesced batch).
    const callsAfterFlush = setState.mock.calls.length;
    expect(callsAfterFlush).toBe(seedCalls + 1);

    // The final state should contain all 51 streaming_text events accumulated.
    const entry = state.find((e) => e.id === "sa-1");
    expect(entry).toBeDefined();
    expect(entry!.streamingText).toBe("Hello" + ".".repeat(50));
  });

  it("flushes immediately on terminal events (turn_complete, error)", () => {
    let state: SubagentProgress[] = [];
    const setState = vi.fn((updater: (prev: SubagentProgress[]) => SubagentProgress[]) => {
      state = updater(state);
    });

    const onEvent = makeAgentProgressTracker("sa-2", "Test Agent", "do stuff", setState);

    // Seed.
    onEvent({ type: "streaming_text", text: "working..." } as AgentEvent);
    const seedCalls = setState.mock.calls.length;

    // Fire some streaming events (throttled).
    onEvent({ type: "streaming_text", text: " more" } as AgentEvent);
    onEvent({ type: "streaming_text", text: " text" } as AgentEvent);
    expect(setState.mock.calls.length).toBe(seedCalls); // still throttled

    // Fire a terminal event — should flush immediately, no timer needed.
    onEvent({ type: "turn_complete" } as AgentEvent);
    expect(setState.mock.calls.length).toBe(seedCalls + 1); // flushed now

    const entry = state.find((e) => e.id === "sa-2");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("done");
    // Streaming text from the throttled batch should also be included.
    expect(entry!.streamingText).toBe(""); // turn_complete clears it
  });

  it("flushes immediately on error events", () => {
    let state: SubagentProgress[] = [];
    const setState = vi.fn((updater: (prev: SubagentProgress[]) => SubagentProgress[]) => {
      state = updater(state);
    });

    const onEvent = makeAgentProgressTracker("sa-3", "Test Agent", "do stuff", setState);

    // Seed.
    onEvent({ type: "streaming_text", text: "start" } as AgentEvent);
    const seedCalls = setState.mock.calls.length;

    // Fire an error event — should flush immediately.
    onEvent({ type: "error", error: new Error("boom") } as AgentEvent);
    expect(setState.mock.calls.length).toBe(seedCalls + 1);

    const entry = state.find((e) => e.id === "sa-3");
    expect(entry!.status).toBe("error");
    expect(entry!.error).toBe("boom");
  });
});
