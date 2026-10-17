import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

export const customizeCommand: SlashCommand = {
  name: "customize",
  description: "Customize Agav's appearance (status bar, …)",
  usage:
    "Usage: /customize\n\nOpens the customization interface.\n\nStatus bar:\n  ↑/↓ Navigate · Space Show/Hide · [ / ] or Shift+↑/↓ Reorder\n  r Restore defaults · Enter Save & close · Esc Back\n\nChanges apply to the footer live and persist across sessions.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    // Interactive-only: the overlay renders inside Ink. In headless/script use
    // there is no footer to customize, so explain rather than failing silently.
    if (!context.showCustomizeTUI || context.isLoading) {
      return {
        type: "message",
        text: "Run /customize in an interactive terminal session.",
      };
    }
    context.setPickerActive(true);
    return new Promise<CommandResult>((resolve, reject) => {
      try {
        context.showCustomizeTUI!(() => {
          context.setPickerActive(false);
          resolve({ type: "none" });
        });
      } catch (error) {
        context.setPickerActive(false);
        reject(error);
      }
    });
  },
};
