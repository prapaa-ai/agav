import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { openResourceManager } from "./resource-manager.js";
import { createResourceAdapter } from "../resources/adapters.js";

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "Manage service agents (list, install, create)",
  usage:
    "Usage: /agents [list]\n\nInteractive tabs: 1 List · 2 Marketplace · 3 Create\n\nShared resource controls:\n  ↑/↓: Navigate · ←/→: Page\n  ENTER/i: Inspect · s: Search · r: Refresh\n  t: Toggle enabled · d: Delete with confirmation\n  c: Configure · v: Agent diagnostics\n  ESC: Back / clear search / exit\n\n/agents list remains textual in scripts.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    if (!args.trim()) {
      const interactive = openResourceManager("agents", context);
      if (interactive) return interactive;
    }
    const adapter = createResourceAdapter("agents");
    if (!args.trim() || args.trim() === "list") {
      const agents = await adapter.list();
      return { type: "message", text: agents.length ? agents.map((a) => `${a.title} [${a.enabled ? "ON" : "OFF"}] ${a.description}`).join("\n") : "No agents installed." };
    }
    return { type: "message", text: "Use /agents in an interactive terminal, or agav agents for CLI management." };
  },
};
