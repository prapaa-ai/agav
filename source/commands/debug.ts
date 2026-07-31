import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { loadPlan } from "../agent/planner.js";
import { loadMemories } from "../config/memory.js";
import { getUndoStack } from "../utils/undo.js";
import { getSandboxName } from "../utils/sandbox.js";

/** Handles the /debug command. */
export const debugCommand: SlashCommand = {
  name: "debug",
  description: "Show internal state for debugging",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const [plan, memories] = await Promise.all([
      loadPlan(),
      loadMemories(),
    ]);
    const undoStack = getUndoStack();
    const debugState = context.getDebugState();

    const lines: string[] = [];
    lines.push("Internal state:");
    lines.push("");
    lines.push(`Conversation messages: ${context.conversation.length}`);
    lines.push(`Conversation token count: ${context.conversation.tokenCount}`);
    lines.push(`Compacted: ${context.conversation.wasCompacted ? "yes" : "no"}`);
    lines.push(`Sandbox: ${getSandboxName()}`);
    lines.push(
      `Token usage: in=${debugState.tokenUsage.inputTokens}, out=${debugState.tokenUsage.outputTokens}, cache_read=${debugState.tokenUsage.cacheReadTokens}, cache_write=${debugState.tokenUsage.cacheWriteTokens}`,
    );
    lines.push("");
    lines.push("Active plan:");
    if (!plan) {
      lines.push("  (none)");
    } else {
      lines.push(`  Goal: ${plan.goal}`);
      lines.push(`  Current step: ${plan.currentStep >= 0 ? plan.currentStep + 1 : "complete"}`);
      for (const step of plan.steps) {
        lines.push(`  - [${step.status}] ${step.id}: ${step.title}`);
      }
    }
    lines.push("");
    lines.push("Loaded plugins:");
    if (debugState.loadedPlugins.length === 0) {
      lines.push("  (none)");
    } else {
      for (const plugin of debugState.loadedPlugins) {
        lines.push(`  - ${plugin}`);
      }
    }
    lines.push("");
    lines.push("MCP servers:");
    if (debugState.mcpServers.length === 0) {
      lines.push("  (none)");
    } else {
      for (const server of debugState.mcpServers) {
        lines.push(`  - ${server}`);
      }
    }
    lines.push(`  Resources discovered: ${debugState.mcpResources}`);
    lines.push(`  Prompts discovered: ${debugState.mcpPrompts}`);
    lines.push("");
    lines.push(`Undo stack (${undoStack.length}):`);
    if (undoStack.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const entry of undoStack) {
        lines.push(`  - ${entry.tool} → ${entry.path}`);
      }
    }
    lines.push("");
    lines.push(`Memory entries (${memories.length}):`);
    if (memories.length === 0) {
      lines.push("  (none)");
    } else {
      for (const memory of memories) {
        lines.push(`  - ${memory.name} [${memory.type}] ${memory.description}`);
      }
    }

    return { type: "message", text: lines.join("\n") };
  },
};
