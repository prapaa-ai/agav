import { EFFORT_LEVELS, isEffortLevel } from "../config/config.js";
import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/** Handles the /effort command. */
export const effortCommand: SlashCommand = {
  name: "effort",
  description: "Show or change reasoning effort",
  usage: "Usage: /effort [level]\n\n  /effort          Show current effort level\n  /effort low      Fast, concise responses\n  /effort medium   Balanced\n  /effort high     Careful, thorough reasoning (default)\n  /effort max      Maximum depth and verification",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const effort = args.trim().toLowerCase();
    if (!effort) {
      return { type: "message", text: `Current effort: ${context.config.effort}` };
    }
    if (!isEffortLevel(effort)) {
      return {
        type: "message",
        text: `Invalid effort level: ${effort}. Use ${EFFORT_LEVELS.join(", ")}.`,
      };
    }

    context.setEffort(effort);
    return { type: "message", text: `Effort changed to: ${effort}` };
  },
};
