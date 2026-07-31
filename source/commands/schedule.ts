import type { SlashCommand, CommandResult } from "./types.js"
import {
  loadScheduledTasks,
  addScheduledTask,
  removeScheduledTask,
  setTaskEnabled,
} from "../config/scheduler.js"

/**
 * Manage persistent scheduled tasks.
 *
 * Scheduled tasks are stored in configuration and survive restarts. Each task
 * contains a cron expression, a user-visible name, an enabled flag, and the
 * prompt that should be submitted when the schedule matches.
 */
export const scheduleCommand: SlashCommand = {
  name: "schedule",
  description: "Manage persistent scheduled tasks",
  usage: "Usage: /schedule <action>\n\n  /schedule list                      Show all scheduled tasks\n  /schedule add \"0 9 * * *\" prompt    Add a cron-scheduled task\n  /schedule remove <id>               Remove a task by ID\n  /schedule enable <id>               Enable a disabled task\n  /schedule disable <id>              Disable a task\n\nCron format: minute hour day-of-month month day-of-week\nTasks persist across sessions in ~/.agav/scheduled-tasks.json.",
  /**
   * Handle schedule management actions.
   *
   * Supported actions:
   * - `list` or no args: show configured tasks
   * - `add`: create a task from a quoted 5-field cron expression and prompt
   * - `remove` / `rm` / `delete`: remove a task by id
   * - `enable`: enable a task by id
   * - `disable`: disable a task by id
   *
   * @param args Raw slash-command arguments following `/schedule`.
   * @returns A user-facing message describing the result.
   */
  async execute(args: string): Promise<CommandResult> {
    /** Tokenized command arguments used to determine the requested action. */
    const parts = args.trim().split(/\s+/)
    /** Default to listing tasks when no explicit action is provided. */
    const action = parts[0]?.toLowerCase() ?? "list"

    /** List tasks when explicitly requested or when no arguments were provided. */
    if (action === "list" || !args.trim()) {
      const tasks = await loadScheduledTasks()
      if (tasks.length === 0) {
        return { type: "message", text: 'No scheduled tasks. Use /schedule add "<cron>" <prompt>' }
      }
      const lines = tasks.map((t) => {
        /** Human-readable enabled state shown in the task list. */
        const status = t.enabled ? "ON" : "OFF"
        /** Localized last-run timestamp, or `never` for untouched tasks. */
        const lastRun = t.lastRunAt
          ? new Date(t.lastRunAt).toLocaleString()
          : "never"
        return `  ${t.id}  [${status}]  ${t.cron.padEnd(15)} ${t.name}\n       Prompt: ${t.prompt}\n       Last run: ${lastRun}`
      })
      return {
        type: "message",
        text: "Scheduled tasks:\n" + lines.join("\n\n"),
      }
    }

    /** Create a new scheduled task from a quoted cron expression and prompt. */
    if (action === "add") {
      const rest = parts.slice(1).join(" ")
      /** Capture a quoted cron expression followed by the prompt text. */
      const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/)
      if (!cronMatch) {
        return {
          type: "message",
          text: 'Usage: /schedule add "<cron>" <prompt>\nExample: /schedule add "0 9 * * 1-5" run morning tests',
        }
      }
      const cron = cronMatch[1]!
      const prompt = cronMatch[2]!
      /** Lightweight validation: require the standard five cron fields. */
      const cronParts = cron.trim().split(/\s+/)
      if (cronParts.length !== 5) {
        return {
          type: "message",
          text: "Invalid cron expression. Must be 5 fields: minute hour day-of-month month day-of-week",
        }
      }
      /** Derive a short display name from the first 40 prompt characters. */
      const name = prompt.slice(0, 40)
      const task = await addScheduledTask(name, cron, prompt)
      return {
        type: "message",
        text: `Scheduled task ${task.id} created: "${cron}" -> ${prompt}`,
      }
    }

    /** Remove an existing task by id, supporting common delete aliases. */
    if (action === "remove" || action === "rm" || action === "delete") {
      const id = parts[1]
      if (!id) {
        return { type: "message", text: "Usage: /schedule remove <id>" }
      }
      const removed = await removeScheduledTask(id)
      return {
        type: "message",
        text: removed ? `Removed task ${id}.` : `Task ${id} not found.`,
      }
    }

    /** Enable a disabled task so it can run on future schedule matches. */
    if (action === "enable") {
      const id = parts[1]
      if (!id) return { type: "message", text: "Usage: /schedule enable <id>" }
      const ok = await setTaskEnabled(id, true)
      return {
        type: "message",
        text: ok ? `Enabled task ${id}.` : `Task ${id} not found.`,
      }
    }

    /** Disable a task without deleting its saved configuration. */
    if (action === "disable") {
      const id = parts[1]
      if (!id) return { type: "message", text: "Usage: /schedule disable <id>" }
      const ok = await setTaskEnabled(id, false)
      return {
        type: "message",
        text: ok ? `Disabled task ${id}.` : `Task ${id} not found.`,
      }
    }

    /** Fallback help for unsupported schedule actions. */
    return {
      type: "message",
      text: "Unknown action. Usage: /schedule list | add | remove | enable | disable",
    }
  },
}
