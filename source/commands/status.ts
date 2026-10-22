import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { getContextLimits } from "../utils/tokens.js";
import { getSandboxName } from "../utils/sandbox.js";
import { computeContextOccupancy, resolveContextWindow } from "./context-usage.js";

// Bun's process.cwd() can return an unresolved value (e.g. the literal "." when
// PWD is relative in the launch environment), which would surface verbatim in the
// status panel. Resolve against the kernel's real working directory so the
// displayed path is always absolute, with layered fallbacks that never throw.
function resolvedCwd(): string {
  const raw = process.cwd();
  if (isAbsolute(raw)) return raw;
  try {
    return realpathSync(".");
  } catch {
    return resolve(raw);
  }
}

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
    await resolveContextWindow(context);

    const limits = getContextLimits(context.config?.model ?? "", context.conversation?.getContextWindow?.());
    const maxTokens = limits.maxTokens;
    // Share the occupancy math with /context so the two cannot drift: it counts
    // the effective prompt, skills, tool schemas, and messages — not just
    // conversation.tokenCount, which understated usage (#563).
    const { usedTokens } = await computeContextOccupancy(context);
    const mcpCount = context.getDebugState?.()?.mcpServers?.length ?? 0;

    // Prefer the live session permission mode: a generic "Always" approval widens
    // it beyond `config.permissionMode`, so reading config alone would report
    // "ask" while writes are actually auto-accepted.
    const permissionMode =
      context.getEffectivePermissionMode?.() ?? context.config?.permissionMode ?? "ask";

    const lines: string[] = [
      "\x1b[1mSession Status\x1b[0m",
      "",
      `  Model:        ${context.config?.model ?? "unknown"} (${context.config?.provider ?? "unknown"})`,
      `  Effort:       ${context.config?.effort ?? "medium"}`,
      `  Permissions:  ${permissionMode} · ${getSandboxName()}`,
      `  Directory:    ${resolvedCwd()}`,
      `  Token usage:  ${fmtTokens(usedTokens)} / ${fmtTokens(maxTokens)} (${pct(usedTokens, maxTokens)})`,
      `  MCP servers:  ${mcpCount} connected`,
    ];

    // preservePaths keeps the absolute Directory path intact: the terminal path
    // formatter would otherwise collapse the working directory back to ".".
    return { type: "message", text: lines.join("\n"), preservePaths: true };
  },
};
