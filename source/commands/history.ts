import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { listSessions, loadSession } from "../config/history.js";
import { isProviderName } from "../config/startup.js";
import { pickSession } from "../utils/session-picker.js";

/** Resume a previous session using the interactive picker. */
export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a previous session",
  usage: "Usage: /resume\n\nOpens an interactive session picker to browse and resume a previous session.\nSessions are auto-saved on exit. Use --resume from CLI to resume by ID.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      return { type: "message", text: "No saved sessions." };
    }

    context.setPickerActive(true);
    const session = await pickSession(sessions);
    context.setPickerActive(false);
    context.refreshDisplay();

    if (!session) {
      return { type: "message", text: "Cancelled." };
    }

    const loaded = await loadSession(session.id);
    if (!loaded) {
      return { type: "message", text: "Failed to load session." };
    }
    context.loadSession(loaded);
    context.setModel(loaded.model || context.config.model);
    if (isProviderName(loaded.provider)) {
      context.setProvider(loaded.provider);
    }
    return {
      type: "message",
      text: `Loaded session: ${loaded.title} (${loaded.messages.length} messages)`,
    };
  },
};
