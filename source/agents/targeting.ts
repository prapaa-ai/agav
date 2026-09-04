/**
 * Agent targeting - direct agent invocation bypassing the main LLM
 */

import type { AgentDefinition } from "./types.js";
import type { LLMProvider } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import type { AgentEvent } from "../agent/loop.js";
import type { SlashCommand, CommandResult } from "../commands/types.js";
import { getCachedAgents } from "./loader.js";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentTargetResult {
  output: string;
  isError: boolean;
  agentName: string;
}

/**
 * Validate that a name corresponds to an enabled, credential-ready agent.
 * Returns the AgentDefinition on success, or a user-facing error string on failure.
 */
export async function resolveTargetAgent(
  nameOrAlias: string,
): Promise<{ agent: AgentDefinition } | { error: string }> {
  const agents = getCachedAgents();
  const lower = nameOrAlias.toLowerCase();
  const agent = agents.find(
    (a) => (a.alias || a.manifest.name).toLowerCase() === lower,
  );
  if (!agent) {
    const names = agents
      .filter((a) => a.manifest.enabled !== false)
      .map((a) => a.alias || a.manifest.name);
    return {
      error: names.length > 0
        ? `Unknown agent: "${nameOrAlias}". Available agents: ${names.join(", ")}`
        : `Unknown agent: "${nameOrAlias}". No agents are installed.`,
    };
  }
  if (agent.manifest.enabled === false) {
    return {
      error: `Agent "${nameOrAlias}" is disabled. Enable it with /agents or \`agav agents enable ${nameOrAlias}\`.`,
    };
  }

  const requiredConfig = agent.manifest["required-config"] ?? [];
  if (requiredConfig.length > 0) {
    const { getMissingCredentials } = await import("./credentials.js");
    const credPath =
      agent.origin === "bundled"
        ? join(homedir(), ".agav", "agents", agent.manifest.name)
        : agent.path;
    const missing = await getMissingCredentials(credPath, agent.manifest);
    if (missing.length > 0) {
      const { setEnvHint, agavHomePath } = await import("../utils/shell-hints.js");
      const lines = [
        `Agent "${nameOrAlias}" is missing required credentials: ${missing.join(", ")}.`,
        ``,
        `Set the following environment variables before starting agav:`,
        ...missing.map((k) => `  ${setEnvHint(k, "<your-value>")}`),
        ``,
        `Or store them in ${agavHomePath(`agents/${agent.manifest.name}/config.json`)}`,
      ];
      return { error: lines.join("\n") };
    }
  }

  return { agent };
}

/**
 * Execute a query against a specific agent, bypassing the main LLM.
 */
export async function executeTargetedAgent(
  agent: AgentDefinition,
  query: string,
  deps: {
    provider: LLMProvider;
    config: AgavConfig;
    hooks?: { afterEdit?: string; afterShell?: string; preCommit?: string };
    signal?: AbortSignal;
    onProgressUpdate?: (callId: string, event: AgentEvent) => void;
    confirmTool?: (toolName: string, input: Record<string, unknown>, diff?: any[]) => Promise<any>;
  },
): Promise<AgentTargetResult> {
  const { executeNativeAgent, executeA2AAgent } = await import("./executor.js");
  const agentType = agent.manifest.type || "native";
  const agentName = agent.alias || agent.manifest.name;

  try {
    let output: string;
    if (agentType === "native") {
      output = await executeNativeAgent(agent, query, deps);
    } else if (agentType === "a2a") {
      output = await executeA2AAgent(agent, query);
    } else {
      return { output: `Unknown agent type: ${agentType}`, isError: true, agentName };
    }
    return { output, isError: false, agentName };
  } catch (err) {
    return {
      output: `Error from ${agentName} agent: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      agentName,
    };
  }
}

/**
 * Create a slash command that invokes an agent directly via `/<agent-name> <query>`.
 */
export function createAgentTargetCommand(agent: AgentDefinition): SlashCommand {
  const name = agent.alias || agent.manifest.name;
  const desc = agent.manifest.description.length > 100
    ? agent.manifest.description.slice(0, 97) + "..."
    : agent.manifest.description;

  return {
    name,
    description: `[agent] ${desc}`,
    usage: `Usage: /${name} <query>\n\nSend a query directly to the ${name} agent.\n${agent.manifest.description}`,
    async execute(args: string): Promise<CommandResult> {
      const query = args.trim();
      if (!query) {
        return {
          type: "message",
          text: `Usage: /${name} <query>\n\nSend a query directly to the ${name} agent.\n${agent.manifest.description}`,
        };
      }
      return { type: "agent_invoke", agentName: name, query };
    },
  };
}
