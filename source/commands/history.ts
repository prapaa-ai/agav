import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { listSessions, loadSession } from "../config/history.js";
import { isProviderName } from "../config/startup.js";
import { pickSession } from "../utils/session-picker.js";

/** Load a session into the active conversation and restore its model/provider. */
function applySession(loaded: NonNullable<Awaited<ReturnType<typeof loadSession>>>, context: CommandContext): CommandResult {
  context.loadSession(loaded);
  context.setModel(loaded.model || context.config.model);
  if (isProviderName(loaded.provider)) {
    context.setProvider(loaded.provider);
  }
  return {
    type: "message",
    text: `Loaded session: ${loaded.title} (${loaded.messages.length} messages)`,
  };
}

/** Resume a previous session via interactive picker or by session ID. */
export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a previous session",
  usage: "Usage: /resume [session-id]\n\n  /resume            Open interactive session picker\n  /resume a1b2c3d4   Load session by ID (prefix match)\n\nSessions are auto-saved on exit. Use --resume from CLI to resume by ID.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const prefix = args.trim();

    // Direct load by session ID prefix
    if (prefix) {
      const sessions = await listSessions();
      const match = sessions.find((s) => s.id.startsWith(prefix));
      if (!match) {
        return { type: "message", text: `No session matching "${prefix}". Use /resume to browse all sessions.` };
      }
      const loaded = await loadSession(match.id);
      if (!loaded) {
        return { type: "message", text: "Failed to load session." };
      }
      return applySession(loaded, context);
    }

    // Interactive picker
    const sessions = await listSessions();
    if (sessions.length === 0) {
      return { type: "message", text: "No saved sessions." };
    }

    context.setPickerActive(true);
    // pickSession draws straight to stdout, so Ink has to stop repainting
    // before its first write rather than after the next await.
    const resumeTerminal = context.suspendTerminal();
    let session: Awaited<ReturnType<typeof pickSession>>;
    try {
      session = await pickSession(sessions);
    } finally {
      resumeTerminal();
      context.setPickerActive(false);
    }
    context.refreshDisplay();

    if (!session) {
      return { type: "message", text: "Cancelled." };
    }

    const loaded = await loadSession(session.id);
    if (!loaded) {
      return { type: "message", text: "Failed to load session." };
    }
    return applySession(loaded, context);
  },
};
