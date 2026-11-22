import type { SlashCommand, CommandResult } from "./types.js"
import { performUndo, performUndoAt, hasUndo, getUndoStack } from "../utils/undo.js"

const USAGE =
  "Usage: /undo [list|<n>]\n\n" +
  "/undo        Restores the previous version of the last file modified by the agent.\n" +
  "/undo <n>    Restores the change numbered <n> in /undo list, keeping newer changes.\n" +
  "/undo list   Lists the tracked changes without reverting any.\n" +
  "Only tracks file writes and edits from the current session."

/** Revert the most recent tracked file change, or the selected stack entry. */
export const undoCommand: SlashCommand = {
  name: "undo",
  description: "Revert the last file change",
  autoSubmit: true,
  usage: USAGE,
  async execute(args: string): Promise<CommandResult> {
    const target = args.trim()

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

    if (/^\d+$/.test(target) || /^[+-]?[\d.]/.test(target)) {
      const stack = getUndoStack()
      if (stack.length === 0) {
        return { type: "message", text: "Nothing to undo." }
      }
      // Only plain digits select an entry; signed, fractional, or suffixed
      // values are malformed and must never mutate files.
      const n = /^\d+$/.test(target) ? Number(target) : NaN
      if (!Number.isInteger(n) || n < 1 || n > stack.length) {
        return {
          type: "message",
          text: `Invalid undo entry: ${target}. Use /undo list to see entry numbers (1-${stack.length}).\n\n${USAGE}`,
        }
      }
      // List numbers count 1 = most recent, so entry <n> sits at index length - n.
      const result = await performUndoAt(stack.length - n)
      if (!result) {
        return { type: "message", text: "Undo failed." }
      }
      return {
        type: "message",
        text: `Reverted ${result.tool} on ${result.path}`,
      }
    }

    if (target !== "") {
      return { type: "message", text: `Unknown argument: ${target}\n\n${USAGE}` }
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
