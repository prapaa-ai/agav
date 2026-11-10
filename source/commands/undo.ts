import type { SlashCommand, CommandResult } from "./types.js"
import { performUndo, hasUndo, getUndoStack } from "../utils/undo.js"

const USAGE =
  "Usage: /undo [list]\n\n" +
  "/undo        Restores the previous version of the last file modified by the agent.\n" +
  "/undo list   Lists the tracked changes without reverting any.\n" +
  "Only tracks file writes and edits from the current session."

/** Revert the most recent tracked file change. */
export const undoCommand: SlashCommand = {
  name: "undo",
  description: "Revert the last file change",
  autoSubmit: true,
  usage: USAGE,
  async execute(args: string): Promise<CommandResult> {
    const target = args.trim()

    if (target !== "" && target !== "list") {
      return { type: "message", text: `Unknown argument: ${target}\n\n${USAGE}` }
    }

    if (target === "list") {
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
