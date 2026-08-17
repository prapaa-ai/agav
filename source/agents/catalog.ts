/**
 * Agent catalog builder - generates token-capped system prompt injection
 */

import type { AgentDefinition } from "./types.js";

const MAX_CATALOG_TOKENS = 500; // rough token budget for the entire catalog
const TOKENS_PER_AGENT = 30; // rough tokens per agent entry (name + description)

/**
 * Build agent catalog string for system prompt injection
 */
export function buildAgentCatalog(agents: AgentDefinition[]): string {
  // Filter to enabled agents only
  const enabledAgents = agents.filter((a) => a.manifest.enabled !== false);

  if (enabledAgents.length === 0) {
    return "";
  }

  // Cap the number of agents shown to stay within token budget
  const maxAgents = Math.floor(MAX_CATALOG_TOKENS / TOKENS_PER_AGENT);
  const agentsToShow = enabledAgents.slice(0, maxAgents);
  const remainingCount = enabledAgents.length - agentsToShow.length;

  const lines = ["Available specialized agents:"];

  for (const agent of agentsToShow) {
    const toolName = `${agent.alias || agent.manifest.name}_agent`;
    const description = agent.manifest.description;
    lines.push(`- ${toolName}: ${description}`);
  }

  if (remainingCount > 0) {
    lines.push(`...and ${remainingCount} more agent(s)`);
  }

  return lines.join("\n");
}
