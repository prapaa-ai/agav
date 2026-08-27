import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/** Set a persistent, human-readable name for the active chat session. */
export const nameCommand: SlashCommand = {
  name: "name",
  description: "Name the current session",
  usage: "Usage: /name <title>\n\n  /name OAuth investigation\n  /name bug fix for login\n\nGives the current session a descriptive name visible in /resume.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const name = args.trim();
    if (!name) {
      return { type: "message", text: "Usage: /name <session name>" };
    }
    context.renameSession(name);
    return { type: "message", text: `Session named: ${name}` };
  },
};
