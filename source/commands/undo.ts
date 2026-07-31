import type { SlashCommand, CommandResult } from "./types.js"
import { performUndo, hasUndo, getUndoStack } from "../utils/undo.js"

/** Revert the most recent tracked file change. */
export const undoCommand: SlashCommand = {
  name: "undo",
  description: "Revert the last file change",
  usage: "Usage: /undo\n\nRestores the previous version of the last file modified by the agent.\nOnly tracks file writes and edits from the current session.",
  async execute(args: string): Promise<CommandResult> {
    if (args.trim() === "list") {
      const stack = getUndoStack()
      if (stack.length === 0) {
        return { type: "message", text: "No changes to undo." }
      }
      const lines = stack.map((e, i) => {
        const ago = Math.round((Date.now() - e.timestamp) / 1000)
        return `  ${stack.length - i}. ${e.tool} → ${e.path} (${ago}s ago)`
      })
      return { type: "message", text: "Undo stack:\n" + lines.join("\n") }
    }

    if (!hasUndo()) {
      return { type: "message", text: "Nothing to undo." }
    }

    const result = await performUndo()
    if (!result) {
      return { type: "message", text: "Undo failed." }
    }

    return {
      type: "message",
      text: `Reverted ${result.tool} on ${result.path}`,
    }
  },
}
