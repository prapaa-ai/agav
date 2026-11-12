import type { SlashCommand } from "./types.js";

/** Hands the current session to its background worker before exiting the UI. */
export const detachCommand: SlashCommand = {
  name: "detach",
  description: "Continue the current session in the background",
  usage: "Usage: /detach\n\nContinue the current session in the background and exit. Resume later with: agav --resume <session-id>",
  async execute(args, context) {
    if (args.trim()) return { type: "message", text: "Usage: /detach" };
    if (!context.detachSession) return { type: "message", text: "Detaching sessions is not supported in this context." };
    try {
      const id = await context.detachSession();
      context.showStatus(`Session ${id} is running in the background. Resume with: agav --resume ${id}`);
      context.exit();
      return { type: "exit" };
    } catch (error) {
      return { type: "message", text: `Failed to detach session: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};
