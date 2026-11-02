import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/** Handles the /exit command. */
export const exitCommand: SlashCommand = {
  name: "exit",
  description: "Exit Agav",
  autoSubmit: true,
  usage: "Usage: /exit\n\nSaves the current session and exits. You can also press Ctrl+Q while idle with an empty prompt (queued requests take priority).\nResume later with: agav --resume",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    context.exit();
    return { type: "exit" };
  },
};
