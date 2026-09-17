import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import {
  performUndo,
  performTurnUndo,
  hasUndo,
  hasTurnUndo,
  getUndoStack,
  getTurnStack,
} from "../utils/undo.js";

/** Revert the most recent tracked file change or full assistant turn. */
export const undoCommand: SlashCommand = {
  name: "undo",
  description: "Revert the last file change or full assistant turn",
  usage:
    "Usage: /undo [file | turn | list]\n\n" +
    "  /undo         Revert the last single file modified by the agent\n" +
    "  /undo turn    Revert ALL files modified during the last assistant turn\n" +
    "  /undo list    Display the file and turn undo history",
  async execute(args: string, _context: CommandContext): Promise<CommandResult> {
    const trimmed = args.trim().toLowerCase();

    if (trimmed === "list") {
      const fileStack = getUndoStack();
      const turnList = getTurnStack(process.cwd());

      if (fileStack.length === 0 && turnList.length === 0) {
        return { type: "message", text: "No changes to undo." };
      }

      let out = "";
      if (turnList.length > 0) {
        out += "Turn Snapshots:\n";
        turnList.forEach((t, i) => {
          const ago = Math.round((Date.now() - t.timestamp) / 1000);
          out += `  [Turn ${turnList.length - i}] ${t.id} (${t.entries.size} files modified, ${ago}s ago)\n`;
        });
        out += "\n";
      }

      if (fileStack.length > 0) {
        out += "File Modifications:\n";
        fileStack.forEach((e, i) => {
          const ago = Math.round((Date.now() - e.timestamp) / 1000);
          out += `  ${fileStack.length - i}. ${e.tool} → ${e.path} (${ago}s ago)\n`;
        });
      }

      return { type: "message", text: out.trim() };
    }

    // Revert entire turn
    if (trimmed === "turn" || trimmed === "all") {
      if (!hasTurnUndo(process.cwd())) {
        return { type: "message", text: "No turn modifications to undo." };
      }

      try {
        const turnResult = await performTurnUndo({ workspaceRoot: process.cwd() });
        if (!turnResult || turnResult.revertedCount === 0) {
          return { type: "message", text: "Turn undo failed or no files modified." };
        }

        const fileList = turnResult.files.map((f) => `  - ${f}`).join("\n");
        return {
          type: "message",
          text: `✓ Successfully reverted turn [${turnResult.turnId}] (${turnResult.revertedCount} files restored):\n${fileList}`,
        };
      } catch (err) {
        return {
          type: "message",
          text: `Turn undo failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Default: revert single file
    if (!hasUndo()) {
      return { type: "message", text: "Nothing to undo." };
    }

    const result = await performUndo();
    if (!result) {
      return { type: "message", text: "Undo failed." };
    }

    return {
      type: "message",
      text: `✓ Reverted ${result.tool} on ${result.path}${result.deleted ? " (deleted new file)" : ""}`,
    };
  },
};
