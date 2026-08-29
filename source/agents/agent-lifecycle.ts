import type { AgentDefinition } from "./types.js";
import { saveTemplate } from "./templates.js";
import { uninstallAgent } from "./installer.js";

/**
 * Saves a user-created agent as a template before uninstalling it,
 * so the user can re-create it later from the wizard.
 *
 * For marketplace/bundled agents (those with a sourceUrl), the template
 * step is skipped and only the uninstall runs.
 */
export async function deleteAgentWithTemplate(
  agent: AgentDefinition,
  opts?: { sourceUrl?: string },
): Promise<{ success: boolean; error?: string; savedTemplate: boolean }> {
  const agentKey = agent.alias || agent.manifest.name;
  const destination = agent.origin === "project" ? "project" : "global";
  let savedTemplate = false;

  if (!opts?.sourceUrl && agent.origin === "global") {
    try {
      await saveTemplate({
        name: agent.manifest.name,
        description: agent.manifest.description,
        systemPrompt: agent.systemPrompt,
        mcpServers: agent.manifest["mcp-servers"],
        tags: agent.manifest.tags,
        savedAt: new Date().toISOString(),
      });
      savedTemplate = true;
    } catch {
      // Template save failed — proceed with deletion anyway
    }
  }

  const result = await uninstallAgent(agentKey, destination);
  return { success: result.success, error: result.error, savedTemplate };
}
