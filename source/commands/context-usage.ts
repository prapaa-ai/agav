import type { CommandContext } from "./types.js";
import { estimateTokens } from "../utils/tokens.js";
import { buildSystemPrompt } from "../utils/system-prompt.js";
import { getCachedSkills, buildSkillCatalog } from "../skills/loader.js";

/**
 * A single estimated breakdown of what currently occupies the context window.
 *
 * This is deliberately the one place the occupancy math lives: `/context` renders
 * the full table from it and `/status` reports the `used`/`max` summary, so the
 * two commands can never drift (the bug in #563 was `/status` counting only
 * `conversation.tokenCount`).
 */
export interface ContextOccupancy {
  /** Tokens for the system prompt (or effective per-turn prompt, which embeds skills). */
  systemTokens: number;
  /** Tokens for non-MCP (built-in) tool schemas. */
  builtinToolTokens: number;
  /** Tokens for MCP tool schemas. */
  mcpToolTokens: number;
  /** Tokens for the skill catalog, or 0 when the effective prompt already embeds it. */
  skillTokens: number;
  /** Tokens for committed conversation messages. */
  messageTokens: number;
  /** Sum of all occupancy components. */
  usedTokens: number;
  /** Built-in (non-MCP) tools in the registry. */
  builtinTools: ReturnType<CommandContext["toolRegistry"]["list"]>;
  /** MCP tools in the registry (by server metadata, not a name prefix). */
  mcpTools: ReturnType<CommandContext["toolRegistry"]["list"]>;
  /** Cached skills. */
  skills: ReturnType<typeof getCachedSkills>;
  /**
   * The effective per-turn prompt captured by the running loop, if any. When
   * undefined the system/skill estimate is name-based and skills are counted
   * separately; when present the prompt already embeds the skill catalog.
   */
  effectivePrompt: string | undefined;
}

/**
 * Compute the estimated context-window occupancy for the current session. Shared
 * by `/context` and `/status` so both report the same numbers.
 */
export async function computeContextOccupancy(context: CommandContext): Promise<ContextOccupancy> {
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

  return {
    systemTokens,
    builtinToolTokens,
    mcpToolTokens,
    skillTokens,
    messageTokens,
    usedTokens,
    builtinTools,
    mcpTools,
    skills,
    effectivePrompt,
  };
}

/**
 * Resolve the real context window reported by the provider into the conversation
 * state, so subsequent occupancy math uses it. Shared by `/context` and `/status`
 * (both previously duplicated this). No-op when a manual or already-resolved
 * window is present, or when the provider cannot report one.
 */
export async function resolveContextWindow(context: CommandContext): Promise<void> {
  const manualOverride = context.conversation.getManualContextWindow(context.config.model);
  if (manualOverride !== undefined) {
    context.conversation.setContextWindow(manualOverride);
    return;
  }
  if (context.conversation.getContextWindow() !== undefined || !context.provider?.getContextWindow) return;

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
