import type { SlashCommand, CommandResult } from "./types.js"
import {
  saveMemory,
  loadMemories,
  deleteMemory,
  deleteAllMemories,
  getProjectMemoryPath,
  type MemoryType,
} from "../config/memory.js"

/** Manage stored memories from the command palette. */
export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Manage persistent memories",
  usage: "Usage: /memory <action>\n\n  /memory              List all saved memories\n  /memory list         Same as above\n  /memory add <text>   Save a new memory\n  /memory delete <N>   Delete memory by index\n  /memory clear        Delete all memories\n  /memory path         Show the memory storage path\n\nMemories persist across sessions and are injected into the system prompt.",
  async execute(args: string): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/)
    const action = parts[0]?.toLowerCase() || "list"

    if (action === "list" || !args.trim()) {
      const memories = await loadMemories()
      if (memories.length === 0) {
        return { type: "message", text: "No memories saved. Memories are auto-saved by the LLM when it detects preferences, corrections, or project context." }
      }
      const lines = memories.map((m) => {
        return `  [${m.type}] ${m.name}\n    ${m.description}`
      })
      return {
        type: "message",
        text: `Memories (${memories.length}):\n${lines.join("\n")}\n\n/memory delete <name> to remove · /memory clear to remove all`,
      }
    }

    if (action === "add") {
      const rest = parts.slice(1).join(" ").trim()
      if (!rest) {
        return { type: "message", text: "Usage: /memory add <text to remember>" }
      }
      const type: MemoryType = rest.toLowerCase().startsWith("prefer") ? "feedback"
        : rest.toLowerCase().startsWith("always") || rest.toLowerCase().startsWith("never") || rest.toLowerCase().startsWith("don't") ? "feedback"
        : "project"
      const slug = rest.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      await saveMemory({ name: slug, description: rest.slice(0, 80), type, content: rest })
      return { type: "message", text: `Saved memory: ${slug}` }
    }

    if (action === "delete" || action === "rm") {
      const name = parts.slice(1).join(" ").trim()
      if (!name) return { type: "message", text: "Usage: /memory delete <name>" }
      const deleted = await deleteMemory(name)
      return { type: "message", text: deleted ? `Deleted memory: ${name}` : `Memory "${name}" not found.` }
    }

    if (action === "clear") {
      const count = await deleteAllMemories()
      return { type: "message", text: count > 0 ? `Cleared ${count} memories.` : "No memories to clear." }
    }

    if (action === "path") {
      return { type: "message", text: `Memory directory: ${getProjectMemoryPath()}` }
    }

    return { type: "message", text: "Usage: /memory [list|add|delete|clear|path]" }
  },
}

/** Save a new memory using free-form text. */
export const rememberCommand: SlashCommand = {
  name: "remember",
  description: "Save a memory",
  usage: "Usage: /remember <text>\n\n  /remember prefer tabs over spaces\n  /remember this project uses pnpm\n\nShortcut for /memory add. Memories persist across sessions.",
  async execute(args: string, context): Promise<CommandResult> {
    return memoryCommand.execute(`add ${args}`, context)
  },
}

/** List memories or delete one by name. */
export const forgetCommand: SlashCommand = {
  name: "forget",
  description: "Delete a memory by name",
  usage: "Usage: /forget [name]\n\n  /forget              List all memories (same as /memory list)\n  /forget prefer-tabs  Delete the memory named 'prefer-tabs'\n\nShortcut for /memory delete.",
  async execute(args: string, context): Promise<CommandResult> {
    if (!args.trim()) return memoryCommand.execute("list", context)
    return memoryCommand.execute(`delete ${args}`, context)
  },
}
