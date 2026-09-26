import { loadRegistry, saveRegistry, acquireRegistryLock } from "./agent-registry.js";
import type { AgentDefinition } from "./types.js";

export async function checkA2AExecutionApproval(
  agent: AgentDefinition,
  confirmTool?: (toolName: string, input: Record<string, unknown>, diff?: any[]) => Promise<any>
): Promise<boolean> {
  const key = agent.alias || agent.manifest.name;
  const startCommand = agent.manifest["start-command"] || "unknown command";

  const registry = await loadRegistry();
  const entry = registry.agents[key];
  if (entry?.approvedExecution && entry.approvedStartCommand === startCommand) {
    return true;
  }

  if (!confirmTool) {
    console.error(`[a2a-approval] Agent ${key} requires execution approval but confirmTool is unavailable.`);
    return false;
  }

  let promptTitle = `A2A Process Execution: ${key}`;
  const promptInput: Record<string, unknown> = { "start-command": startCommand };

  if (entry?.approvedExecution && entry.approvedStartCommand && entry.approvedStartCommand !== startCommand) {
    promptTitle = `🚨 SECURITY WARNING: ${key}`;
    promptInput["WARNING"] = `The start command was changed from what you previously approved ("${entry.approvedStartCommand}").`;
  }

  const choice = await confirmTool(promptTitle, promptInput);

  if (choice === "yes" || choice === "always") {
    if (choice === "always") {
      const release = await acquireRegistryLock();
      try {
        const reg = await loadRegistry();
        if (reg.agents[key]) {
          reg.agents[key].approvedExecution = true;
          reg.agents[key].approvedStartCommand = startCommand;
          await saveRegistry(reg);
        }
      } finally {
        release();
      }
    }
    return true;
  }

  return false;
}
