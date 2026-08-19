import { watch } from "node:fs"
import { execFile } from "node:child_process"
import { resolve } from "node:path"
import type { SlashCommand, CommandResult, CommandContext } from "./types.js"

let activeWatcher: ReturnType<typeof watch> | null = null

function matchGlob(pattern: string, filename: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*\*\//g, "(?:/.*/?|/)")
    .replace(/\/\*\*/g, "(?:/.*)?")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
  return new RegExp(`^${regex}$`).test(filename)
}

function isGlob(path: string): boolean {
  return /[*?{]/.test(path)
}

function getWatchRoot(pattern: string): string {
  const parts = pattern.split("/")
  const staticParts: string[] = []
  for (const part of parts) {
    if (isGlob(part)) break
    staticParts.push(part)
  }
  return staticParts.length > 0 ? staticParts.join("/") : "."
}

export const watchCommand: SlashCommand = {
  name: "watch",
  description: "Watch files and run a command on change",
  usage: "Usage: /watch <path|glob> <command>\n\n  /watch source npm test          Watch a directory\n  /watch source/**/*.ts npm test   Watch with glob pattern\n  /watch stop                      Stop the active watcher\n\nGlob patterns are supported. Changes are debounced (300ms).",
  async execute(args: string, _context: CommandContext): Promise<CommandResult> {
    const trimmed = args.trim()

    if (trimmed === "stop") {
      if (activeWatcher) {
        activeWatcher.close()
        activeWatcher = null
        return { type: "message", text: "File watcher stopped." }
      }
      return { type: "message", text: "No active watcher." }
    }

    if (!trimmed) {
      const status = activeWatcher ? "Active" : "Inactive"
      return {
        type: "message",
        text: `Watcher: ${status}\nUsage: /watch <path|glob> <command>\nExample: /watch source/**/*.ts tsc --noEmit\nStop: /watch stop`,
      }
    }

    const parts = trimmed.split(/\s+/)
    const watchPattern = parts[0]!
    const command = parts.slice(1).join(" ")

    if (!command) {
      return { type: "message", text: "Missing command. Usage: /watch <path|glob> <command>" }
    }

    if (activeWatcher) {
      activeWatcher.close()
    }

    const hasGlob = isGlob(watchPattern)
    const watchDir = hasGlob ? resolve(getWatchRoot(watchPattern)) : resolve(watchPattern)

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    try {
      activeWatcher = watch(watchDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        if (filename.includes("node_modules") || filename.includes(".git") || filename.includes("build/")) return

        if (hasGlob) {
          const root = getWatchRoot(watchPattern)
          const fullRelative = root === "." ? filename : `${root}/${filename}`
          if (!matchGlob(watchPattern, fullRelative)) return
        }

        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          _context.showStatus(`AUTOMATION  /watch · ${filename} changed → ${command}`)
          execFile("/bin/sh", ["-c", command], { timeout: 30_000, cwd: process.cwd() }, (_err, stdout, stderr) => {
            const output = (stdout + stderr).trim()
            if (output) {
              process.stderr.write(`\n[AUTOMATION /watch] ${filename} changed → ${command}\n${output}\n`)
            }
          })
        }, 300)
      })
    } catch (err: any) {
      return { type: "message", text: `Watch failed: ${err.message ?? err}` }
    }

    const displayPath = hasGlob ? `${watchPattern} (watching ${watchDir})` : watchPattern
    return {
      type: "message",
      text: `Watching ${displayPath} → ${command}\nUse /watch stop to disable.`,
    }
  },
}
