import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { isKnownProvider } from "../config/config.js";
import { listSessions, loadSession } from "../config/history.js";

/** List saved sessions or load one into the active conversation. */
export const historyCommand: SlashCommand = {
  name: "history",
  description: "List saved sessions or load one by index",
  usage: "Usage: /history [index]\n\n  /history       List all saved sessions with timestamps\n  /history 1     Resume session #1 from the list\n\nSessions are auto-saved on exit. Use --resume from CLI to resume by ID.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const index = parseInt(args.trim(), 10);

    if (!isNaN(index)) {
      const sessions = await listSessions();
      const session = sessions[index - 1];
      if (!session) {
        return {
          type: "message",
          text: `No session at index ${index}. Type /history to list sessions.`,
        };
      }
      const loaded = await loadSession(session.id);
      if (!loaded) {
        return { type: "message", text: "Failed to load session." };
      }
      context.loadSession(loaded);
      context.setModel(loaded.model || context.config.model);
      if (isKnownProvider(loaded.provider)) {
        context.setProvider(loaded.provider);
      }
      return {
        type: "message",
        text: `Loaded session: ${loaded.title} (${loaded.messages.length} messages)`,
      };
    }

    const sessions = await listSessions();
    if (sessions.length === 0) {
      return { type: "message", text: "No saved sessions." };
    }

    const lines = sessions.slice(0, 10).map((s, i) => {
      const date = new Date(s.createdAt).toLocaleString();
      return `  ${i + 1}. ${s.title} (${date})`;
    });

    return {
      type: "message",
      text: "Recent sessions:\n" + lines.join("\n") + "\n\nUse /history <number> to load a session.",
    };
  },
};
