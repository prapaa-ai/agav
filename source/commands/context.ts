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
    const limits = getContextLimits(context.config.model, context.conversation.getContextWindow());
    const maxTokens = limits.maxTokens;

    const systemPrompt = await buildSystemPrompt();
    const systemTokens = estimateTokens(systemPrompt);

    const allTools = context.toolRegistry.list();
    const mcpTools = allTools.filter(t => t.schema.name.startsWith("mcp__"));
    const builtinTools = allTools.filter(t => !t.schema.name.startsWith("mcp__"));

    const schemas = context.toolRegistry.getSchemas();
    let builtinToolTokens = 0;
    let mcpToolTokens = 0;
    for (const s of schemas) {
      const tokens = estimateTokens(s.name) + estimateTokens(s.description ?? "") + estimateTokens(JSON.stringify(s.inputSchema ?? {}));
      if (s.name.startsWith("mcp__")) {
        mcpToolTokens += tokens;
      } else {
        builtinToolTokens += tokens;
      }
    }

    const skills = getCachedSkills();
    const skillCatalog = buildSkillCatalog(skills);
    const skillTokens = skillCatalog ? estimateTokens(skillCatalog) : 0;

    const messageTokens = context.conversation.tokenCount;
    const usedTokens = systemTokens + builtinToolTokens + mcpToolTokens + skillTokens + messageTokens;
    const freeTokens = Math.max(0, maxTokens - usedTokens);

    const debugState = context.getDebugState();

    const rows: [string, string, string][] = [
      [`  System prompt`, fmtTokens(systemTokens), pct(systemTokens, maxTokens)],
      [`  Built-in tools (${builtinTools.length})`, fmtTokens(builtinToolTokens), pct(builtinToolTokens, maxTokens)],
      [`  MCP tools (${mcpTools.length})`, fmtTokens(mcpToolTokens), pct(mcpToolTokens, maxTokens)],
      [`  Skills (${skills.length})`, fmtTokens(skillTokens), pct(skillTokens, maxTokens)],
      [`  Messages (${context.conversation.length})`, fmtTokens(messageTokens), pct(messageTokens, maxTokens)],
    ];

    const lines: string[] = [];
    lines.push("\x1b[1mContext Usage\x1b[0m");
    lines.push("");
    lines.push(`  Model:     ${context.config.model} (${context.config.provider})`);
    lines.push(`  Compacted: ${context.conversation.wasCompacted ? "yes" : "no"}`);
    lines.push("");
    lines.push("  \x1b[2m" + "─".repeat(48) + "\x1b[0m");

    for (const [label, tokens, percent] of rows) {
      lines.push(`${label.padEnd(30)} ${tokens.padStart(8)}  ${percent.padStart(6)}`);
    }

    lines.push("  \x1b[2m" + "─".repeat(48) + "\x1b[0m");
    lines.push(`${"  Used".padEnd(30)} ${fmtTokens(usedTokens).padStart(8)}  ${pct(usedTokens, maxTokens).padStart(6)}`);
    lines.push(`${"  Free".padEnd(30)} ${fmtTokens(freeTokens).padStart(8)}  ${pct(freeTokens, maxTokens).padStart(6)}`);
    lines.push(`${"  Total".padEnd(30)} ${fmtTokens(maxTokens).padStart(8)}`);

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
