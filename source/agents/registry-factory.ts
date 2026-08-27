/**
 * Agent registry factory - converts agents into callable tools
 */

import type { AgentDefinition } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";
import { executeNativeAgent, executeA2AAgent } from "./executor.js";
import { agavHomePath, setEnvHint } from "../utils/shell-hints.js";

// AgavHooks type - defined locally since it's not exported from hooks.js
interface AgavHooks {
  afterEdit?: string;
  afterShell?: string;
  preCommit?: string;
}

/**
 * Convert an agent into a ToolDefinition that can be called by the main agent
 */
export function agentToTool(
  agent: AgentDefinition,
  deps: {
    provider: LLMProvider;
    config: AgavConfig;
    hooks?: AgavHooks;
    onProgressUpdate?: (callId: string, event: import("../agent/loop.js").AgentEvent) => void;
    confirmTool?: (toolName: string, input: Record<string, unknown>, diff?: any[]) => Promise<any>;
  }
): ToolDefinition {
  const toolName = `${agent.alias || agent.manifest.name}_agent`;

  return {
    schema: {
      name: toolName,
      description: agent.manifest.description,
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to delegate to this specialized agent",
          },
        },
        required: ["task"],
      },
    },
    async execute(input) {
      const task = String(input.task || "");

      try {
        // Guard: check required credentials before running.
        // Bundled agents store credentials in ~/.agav/agents/<name>/, not agent.path.
        const requiredConfig = agent.manifest["required-config"] ?? [];
        if (requiredConfig.length > 0) {
          const { getMissingCredentials } = await import("./credentials.js");
          const { homedir } = await import("node:os");
          const { join } = await import("node:path");
          const credPath = agent.origin === "bundled"
            ? join(homedir(), ".agav", "agents", agent.manifest.name)
            : agent.path;
          const missing = await getMissingCredentials(credPath, agent.manifest);
          if (missing.length > 0) {
            const agentName = agent.manifest.name;
            const lines = [
              `Cannot run the ${agentName} agent — missing required configuration: ${missing.join(", ")}.`,
              ``,
              `To configure, set the following environment variables before starting agav:`,
              ...missing.map((k) => `  ${setEnvHint(k, "<your-value>")}`),
              ``,
              `Or store them permanently in ${agavHomePath(`agents/${agentName}/config.json`)}`,
            ];
            return { output: lines.join("\n"), isError: true };
          }
        }

        const agentType = agent.manifest.type || "native";

        let output: string;
        if (agentType === "native") {
          output = await executeNativeAgent(agent, task, deps);
        } else if (agentType === "a2a") {
          output = await executeA2AAgent(agent, task);
        } else {
          throw new Error(`Unknown agent type: ${agentType}`);
        }

        return {
          output,
          isError: false,
        };
      } catch (error) {
        return {
          output: `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}
