import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { getContextLimits } from "../utils/tokens.js";
import { computeContextOccupancy, resolveContextWindow } from "./context-usage.js";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
}

export const contextCommand: SlashCommand = {
  name: "context",
  description: "Show context window usage",
  usage: "Usage: /context\n\nShows a breakdown of what's consuming your context window:\nsystem prompt, tools, MCP tools, skills, and conversation messages.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    await resolveContextWindow(context);
    const limits = getContextLimits(context.config.model, context.conversation.getContextWindow());
    const maxTokens = limits.maxTokens;

    const occupancy = await computeContextOccupancy(context);
    const {
      systemTokens, builtinToolTokens, mcpToolTokens, skillTokens, messageTokens,
      usedTokens, builtinTools, mcpTools, skills, effectivePrompt,
    } = occupancy;
    const freeTokens = Math.max(0, maxTokens - usedTokens);

    const debugState = context.getDebugState();

    const rows: [string, string, string][] = [
      [effectivePrompt === undefined ? "  System prompt" : "  System prompt + skills", fmtTokens(systemTokens), pct(systemTokens, maxTokens)],
      [`  Non-MCP tools (${builtinTools.length})`, fmtTokens(builtinToolTokens), pct(builtinToolTokens, maxTokens)],
      [`  MCP tools (${mcpTools.length})`, fmtTokens(mcpToolTokens), pct(mcpToolTokens, maxTokens)],
      ...(effectivePrompt === undefined
        ? [[`  Skills (${skills.length})`, fmtTokens(skillTokens), pct(skillTokens, maxTokens)] as [string, string, string]]
        : []),
      [`  Messages (${context.conversation.length})`, fmtTokens(messageTokens), pct(messageTokens, maxTokens)],
    ];

    const lines: string[] = [];
    lines.push("\x1b[1mContext Usage\x1b[0m");
    lines.push("");
    lines.push(`  Model:     ${context.config.model} (${context.config.provider})`);
    lines.push(`  Compacted: ${context.conversation.wasCompacted ? "yes" : "no"}`);
    lines.push("  Estimated context window usage (not cumulative token usage).");
    if (context.isLoading) {
      lines.push("  Snapshot of committed messages; excludes in-flight output.");
    }
    if (effectivePrompt === undefined) {
      lines.push("  Prompt estimate; stable per-turn context is not yet captured.");
    }
    lines.push("");
    lines.push("  \x1b[2m" + "─".repeat(48) + "\x1b[0m");

    for (const [label, tokens, percent] of rows) {
      lines.push(`${label.padEnd(30)} ${tokens.padStart(8)}  ${percent.padStart(6)}`);
    }

    lines.push("  \x1b[2m" + "─".repeat(48) + "\x1b[0m");
    lines.push(`${"  Used".padEnd(30)} ${fmtTokens(usedTokens).padStart(8)}  ${pct(usedTokens, maxTokens).padStart(6)}`);
    lines.push(`${"  Free".padEnd(30)} ${fmtTokens(freeTokens).padStart(8)}  ${pct(freeTokens, maxTokens).padStart(6)}`);
    lines.push(`${"  Total".padEnd(30)} ${fmtTokens(maxTokens).padStart(8)}`);

    if (debugState.tokenUsage) {
      const usage = debugState.tokenUsage;
      lines.push("");
      lines.push("\x1b[1mSession totals (all requests, not context occupancy)\x1b[0m");
      lines.push(`  ${fmtTokens(usage.inputTokens)} ↑ ${fmtTokens(usage.outputTokens)} ↓ ${fmtTokens(usage.cacheReadTokens)} ⇢${usage.cacheWriteTokens > 0 ? ` ${fmtTokens(usage.cacheWriteTokens)} ⇠` : ""}`);
    }

    if (debugState.mcpServers.length > 0) {
      lines.push("");
      lines.push("\x1b[1mMCP Servers\x1b[0m");
      for (const server of debugState.mcpServers) {
        lines.push(`  - ${server}`);
      }
    }

    return { type: "message", text: lines.join("\n") };
  },
};
