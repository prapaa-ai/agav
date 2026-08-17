/**
 * Shared helper for tracking named-agent and subagent progress in the UI.
 * Used by both the built-in `subagent` tool and named agents registered via agentToTool().
 */

import type { SubagentProgress } from "./subagent-types.js";
import type { AgentEvent } from "./loop.js";

/**
 * Creates a progress tracker for a single agent invocation.
 *
 * Returns an `onEvent` function that should be called for every AgentEvent
 * emitted by the child runAgentLoop. It maintains a SubagentProgress entry
 * in the provided state setter, creating it on first call.
 *
 * @param id       Unique ID for this agent invocation
 * @param title    Display name (agent manifest name or subagent title)
 * @param task     Task description (shown in detail view)
 * @param setState React state setter for the SubagentProgress[] array
 */
export function makeAgentProgressTracker(
  id: string,
  title: string,
  task: string,
  setState: (updater: (prev: SubagentProgress[]) => SubagentProgress[]) => void,
): (event: AgentEvent) => void {
  let seeded = false;

  function seed() {
    if (seeded) return;
    seeded = true;
    const entry: SubagentProgress = {
      id,
      title,
      task,
      status: "running",
      toolCalls: [],
      streamingText: "",
      startedAt: Date.now(),
      totalToolCalls: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
    setState((prev) => [...prev, entry]);
  }

  function update(updater: (entry: SubagentProgress) => SubagentProgress) {
    setState((prev) =>
      prev.map((e) => (e.id === id ? updater(e) : e))
    );
  }

  return (event: AgentEvent) => {
    seed();

    switch (event.type) {
      case "streaming_text":
        update((e) => ({ ...e, streamingText: e.streamingText + event.text }));
        break;

      case "tool_call_start":
        update((e) => ({
          ...e,
          totalToolCalls: e.totalToolCalls + 1,
          toolCalls: [...e.toolCalls, { toolName: event.toolName, input: {}, status: "running" }],
        }));
        break;

      case "tool_result":
        update((e) => ({
          ...e,
          toolCalls: e.toolCalls.map((tc) =>
            tc.toolName === event.toolName && tc.status === "running"
              ? { ...tc, status: event.isError ? "error" : "done" }
              : tc
          ),
        }));
        break;

      case "assistant_message_complete":
        update((e) => ({ ...e, streamingText: "", toolCalls: [] }));
        break;

      case "turn_complete":
        // Mark done but keep visible — the next turn's setSubagentStates([]) handles cleanup.
        // This lets the user see which sub-tools were called after the agent finishes.
        update((e) => ({ ...e, status: "done", streamingText: "" }));
        break;

      case "error":
        update((e) => ({ ...e, status: "error", error: event.error.message, streamingText: "" }));
        break;

      case "usage":
        update((e) => ({
          ...e,
          tokenUsage: {
            inputTokens: e.tokenUsage.inputTokens + event.inputTokens,
            outputTokens: e.tokenUsage.outputTokens + event.outputTokens,
            cacheReadTokens: e.tokenUsage.cacheReadTokens + (event.cacheReadTokens ?? 0),
          },
        }));
        break;
    }
  };
}
