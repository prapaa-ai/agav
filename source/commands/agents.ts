import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "Manage service agents (list, install, create)",
  usage:
    "Usage: /agents\n\nOpens an interactive TUI for managing agents:\n  Tab 1: List installed agents\n  Tab 2: Browse marketplace\n\nKeyboard shortcuts:\n  1/2: Switch tabs\n  ↑/↓: Navigate\n  ENTER: Toggle enable/disable\n  i: Inspect agent details\n  d: Remove agent (global/project agents only)\n  r: Refresh marketplace\n  b/ESC: Back (in inspect view)\n  ESC: Exit",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    context.setPickerActive(true);
    return new Promise<CommandResult>((resolve) => {
      context.showAgentsTUI(() => {
        resolve({ type: "none" });
      });
    });
  },
};
