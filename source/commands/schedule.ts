import type { SlashCommand, CommandResult } from "./types.js";
import { agavHomePath } from "../utils/shell-hints.js";
import {
  loadScheduledTasks,
  addScheduledTask,
  addScheduledProcessTask,
  removeScheduledTask,
  setTaskEnabled,
} from "../config/scheduler.js";

/**
 * Manage persistent scheduled tasks.
 *
 * Scheduled tasks are stored in configuration and survive restarts. Prompt
 * tasks submit text to the agent on a cron expression; process tasks start a
 * daemon-backed background command directly, without waiting for the LLM.
 */
export const scheduleCommand: SlashCommand = {
  name: "schedule",
  description: "Manage persistent scheduled tasks",
  usage: `Usage: /schedule <action>

  /schedule list                           Show all scheduled tasks
  /schedule add "0 9 * * *" prompt         Add a cron-scheduled agent prompt
  /schedule background "0 9 * * *" command Start a daemon background command on schedule
  /schedule remove <id>                    Remove a task by ID
  /schedule enable <id>                    Enable a disabled task
  /schedule disable <id>                   Disable a task

Cron format: minute hour day-of-month month day-of-week
Tasks persist across sessions in ${agavHomePath("scheduled-tasks.json")}.`,
  async execute(args: string): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase() ?? "list";

    if (action === "list" || !args.trim()) {
      const tasks = await loadScheduledTasks();
      if (tasks.length === 0) {
        return { type: "message", text: 'No scheduled tasks. Use /schedule add "<cron>" <prompt> or /schedule background "<cron>" <command>' };
      }
      const lines = tasks.map((t) => {
        const status = t.enabled ? "ON" : "OFF";
        const lastRun = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : "never";
        const kind = t.kind === "process" ? "process" : "prompt";
        const payload = t.kind === "process" ? `Command: ${t.command ?? t.prompt}` : `Prompt: ${t.prompt}`;
        return `  ${t.id}  [${status}]  [${kind}]  ${t.cron.padEnd(15)} ${t.name}\n       ${payload}\n       Last run: ${lastRun}`;
      });
      return { type: "message", text: "Scheduled tasks:\n" + lines.join("\n\n") };
    }

    if (action === "add" || action === "background" || action === "bg" || action === "process") {
      const rest = parts.slice(1).join(" ");
      const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
      if (!cronMatch) {
        return {
          type: "message",
          text: action === "add"
            ? 'Usage: /schedule add "<cron>" <prompt>\nExample: /schedule add "0 9 * * 1-5" run morning tests'
            : 'Usage: /schedule background "<cron>" <command>\nExample: /schedule background "0 9 * * 1-5" pnpm test',
        };
      }
      const cron = cronMatch[1]!;
      const payload = cronMatch[2]!;
      const cronParts = cron.trim().split(/\s+/);
      if (cronParts.length !== 5) {
        return { type: "message", text: "Invalid cron expression. Must be 5 fields: minute hour day-of-month month day-of-week" };
      }
      const name = payload.slice(0, 40);
      const task = action === "add"
        ? await addScheduledTask(name, cron, payload)
        : await addScheduledProcessTask(name, cron, payload, process.cwd());
      return {
        type: "message",
        text: task.kind === "process"
          ? `Scheduled background process ${task.id} created: "${cron}" -> ${payload}`
          : `Scheduled task ${task.id} created: "${cron}" -> ${payload}`,
      };
    }

    if (action === "remove" || action === "rm" || action === "delete") {
      const id = parts[1];
      if (!id) return { type: "message", text: "Usage: /schedule remove <id>" };
      const removed = await removeScheduledTask(id);
      return { type: "message", text: removed ? `Removed task ${id}.` : `Task ${id} not found.` };
    }

    if (action === "enable") {
      const id = parts[1];
      if (!id) return { type: "message", text: "Usage: /schedule enable <id>" };
      const ok = await setTaskEnabled(id, true);
      return { type: "message", text: ok ? `Enabled task ${id}.` : `Task ${id} not found.` };
    }

    if (action === "disable") {
      const id = parts[1];
      if (!id) return { type: "message", text: "Usage: /schedule disable <id>" };
      const ok = await setTaskEnabled(id, false);
      return { type: "message", text: ok ? `Disabled task ${id}.` : `Task ${id} not found.` };
    }

    return { type: "message", text: "Unknown action. Usage: /schedule list | add | background | remove | enable | disable" };
  },
};
