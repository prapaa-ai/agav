import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { getContextLimits } from "../utils/tokens.js";
import { getSandboxName } from "../utils/sandbox.js";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
}

export const statusCommand: SlashCommand = {
  name: "status",
  description: "Show session status, model, and resource usage at a glance",
  usage: "Usage: /status\n\nShows active session configuration, model, reasoning effort, permissions, working directory, token usage, and MCP servers.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const manualOverride = context.conversation?.getManualContextWindow?.(context.config?.model);
    if (manualOverride !== undefined) {
      context.conversation?.setContextWindow?.(manualOverride);
    } else if (context.conversation?.getContextWindow?.() === undefined && context.provider?.getContextWindow) {
      const selectionVersion = context.getModelSelectionVersion?.();
      try {
        const reported = await context.provider.getContextWindow(context.config.model);
        if (
          reported !== undefined &&
          reported > 0 &&
          (selectionVersion === undefined || context.getModelSelectionVersion?.() === selectionVersion)
        ) {
          context.conversation?.setContextWindow?.(reported);
        }
      } catch {
        // Metadata is optional; retain the name-based estimate when lookup fails.
      }
    }

    const limits = getContextLimits(context.config?.model ?? "", context.conversation?.getContextWindow?.());
    const maxTokens = limits.maxTokens;
    const usedTokens = context.conversation?.tokenCount ?? 0;
    const mcpCount = context.getDebugState?.()?.mcpServers?.length ?? 0;

    const lines: string[] = [
      "\x1b[1mSession Status\x1b[0m",
      "",
      `  Model:        ${context.config?.model ?? "unknown"} (${context.config?.provider ?? "unknown"})`,
      `  Effort:       ${context.config?.effort ?? "medium"}`,
      `  Permissions:  ${context.config?.permissionMode ?? "ask"} · ${getSandboxName()}`,
      `  Directory:    ${process.cwd()}`,
      `  Token usage:  ${fmtTokens(usedTokens)} / ${fmtTokens(maxTokens)} (${pct(usedTokens, maxTokens)})`,
      `  MCP servers:  ${mcpCount} connected`,
    ];

    return { type: "message", text: lines.join("\n") };
  },
};
