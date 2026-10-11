import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { estimateTokens, getContextLimits } from "../utils/tokens.js";
import { buildSystemPrompt } from "../utils/system-prompt.js";
import { getCachedSkills, buildSkillCatalog } from "../skills/loader.js";

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
    const manualOverride = context.conversation.getManualContextWindow(context.config.model);
    if (manualOverride !== undefined) {
      context.conversation.setContextWindow(manualOverride);
    } else if (context.conversation.getContextWindow() === undefined && context.provider?.getContextWindow) {
      const selectionVersion = context.getModelSelectionVersion?.();
      try {
        const reported = await context.provider.getContextWindow(context.config.model);
        if (reported !== undefined && reported > 0
          && (selectionVersion === undefined || context.getModelSelectionVersion?.() === selectionVersion)) {
          context.conversation.setContextWindow(reported);
        }
      } catch {
        // Metadata is optional; retain the name-based estimate when lookup fails.
      }
    }
    const limits = getContextLimits(context.config.model, context.conversation.getContextWindow());
    const maxTokens = limits.maxTokens;

    const effectivePrompt = context.conversation.getSystemPrompt();
    const systemPrompt = effectivePrompt ?? context.config.systemPrompt ?? await buildSystemPrompt();
    const systemTokens = estimateTokens(systemPrompt);

    const allTools = context.toolRegistry.list();
    const mcpTools = allTools.filter(t => t.mcpServerName !== undefined || t.schema.name === "mcp_read_resource");
    const mcpNames = new Set(mcpTools.map(t => t.schema.name));
    const builtinTools = allTools.filter(t => !mcpNames.has(t.schema.name));

    const schemas = context.toolRegistry.getSchemas();
    let builtinToolTokens = 0;
    let mcpToolTokens = 0;
    for (const s of schemas) {
      const tokens = estimateTokens(s.name) + estimateTokens(s.description ?? "") + estimateTokens(JSON.stringify(s.inputSchema ?? {}));
      if (mcpNames.has(s.name)) {
        mcpToolTokens += tokens;
      } else {
        builtinToolTokens += tokens;
      }
    }

    const skills = getCachedSkills();
    const skillCatalog = buildSkillCatalog(skills);
    // Stable context already embeds the skill catalog in an effective prompt.
    const skillTokens = effectivePrompt === undefined && skillCatalog ? estimateTokens(skillCatalog) : 0;

    const messageTokens = context.conversation.tokenCount;
    const usedTokens = systemTokens + builtinToolTokens + mcpToolTokens + skillTokens + messageTokens;
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
