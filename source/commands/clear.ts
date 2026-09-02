import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/** Starts a new session while preserving saved conversation history. */
export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Start a new chat (alias: /new)",
  usage: "Usage: /clear\n\nClears the current conversation and starts fresh.\nYour previous session is auto-saved — use /resume to reopen it.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    context.clearMessages();
    return { type: "message", text: "Started a new chat. Your previous sessions are still saved; use /resume to reopen one." };
  },
};

export const newCommand: SlashCommand = {
  ...clearCommand,
  name: "new",
  description: "Start a new chat without deleting saved sessions",
};
