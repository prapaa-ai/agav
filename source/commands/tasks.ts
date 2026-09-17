import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { getGlobalTaskManager } from "../tasks/task-manager.js";
import { TaskWatcher } from "../tasks/watcher.js";

export const tasksCommand: SlashCommand = {
  name: "tasks",
  description: "View and manage background orchestration tasks and concurrency",
  usage:
    "Usage: /tasks [status <id> | cancel <id> | clear | active | all]\n\n" +
    "  /tasks               List active and recent tasks\n" +
    "  /tasks active        List only active / running tasks\n" +
    "  /tasks status <id>   Display detailed metadata and results for a task\n" +
    "  /tasks cancel <id>   Cancel a running or queued task\n" +
    "  /tasks clear         Clear finished tasks from history",

  async execute(args: string, _context: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    const manager = getGlobalTaskManager();
    const watcher = TaskWatcher.getInstance();

    if (sub === "help" || sub === "--help" || sub === "-h") {
      return {
        type: "message",
        text: [
          "Task Orchestration Command Usage:",
          "  /tasks               Show all running and recent tasks",
          "  /tasks active        Show only currently running/queued tasks",
          "  /tasks status <id>   Show full details and results for task <id>",
          "  /tasks cancel <id>   Cancel task <id> and cascade abort",
          "  /tasks clear         Clear completed tasks from history",
        ].join("\n"),
      };
    }

    if (sub === "status") {
      const taskId = parts[1];
      if (!taskId) {
        return {
          type: "message",
          text: "Missing task ID. Usage: /tasks status <task-id>",
        };
      }

      const task = manager.getTask(taskId);
      if (!task) {
        return {
          type: "message",
          text: `Task "${taskId}" not found.`,
        };
      }

      const durationMs =
        task.completedAt && task.startedAt
          ? task.completedAt - task.startedAt
          : task.startedAt
          ? Date.now() - task.startedAt
          : 0;

      const lines = [
        `Task Details: ${task.id}`,
        `  Title: ${task.title}`,
        `  Task: ${task.task}`,
        `  State: ${task.state.toUpperCase()}`,
        `  Progress: ${task.progress}%`,
        `  Duration: ${(durationMs / 1000).toFixed(2)}s`,
        `  Retries: ${task.retries} / ${task.maxRetries}`,
        `  Parent: ${task.parentId ?? "None"}`,
        `  Dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(", ") : "None"}`,
      ];

      if (task.error) {
        lines.push(`  Error: ${task.error}`);
      }

      if (task.partialResult !== undefined) {
        lines.push(`  Partial Result: ${JSON.stringify(task.partialResult)}`);
      }

      if (task.result !== undefined) {
        lines.push(`  Result: ${JSON.stringify(task.result)}`);
      }

      return {
        type: "message",
        text: lines.join("\n"),
      };
    }

    if (sub === "cancel") {
      const taskId = parts[1];
      if (!taskId) {
        return {
          type: "message",
          text: "Missing task ID. Usage: /tasks cancel <task-id>",
        };
      }

      const cancelled = manager.cancelTask(taskId, "Cancelled via /tasks command");
      if (cancelled) {
        return {
          type: "message",
          text: `✓ Task "${taskId}" was cancelled.`,
        };
      } else {
        return {
          type: "message",
          text: `Could not cancel task "${taskId}" (task not found or already terminal).`,
        };
      }
    }

    if (sub === "clear") {
      manager.clearHistory();
      return {
        type: "message",
        text: "✓ Cleared completed and terminal tasks from history.",
      };
    }

    const onlyActive = sub === "active";
    const snapshots = onlyActive ? watcher.getActiveSnapshots() : watcher.getSnapshots();

    if (snapshots.length === 0) {
      return {
        type: "message",
        text: onlyActive ? "No active background tasks running." : "No tasks in history.",
      };
    }

    const lines = [
      onlyActive ? "Active Background Tasks:" : "Background Orchestration Tasks:",
      `  Concurrency Limit: ${manager.maxConcurrent}`,
      "",
    ];

    for (const s of snapshots) {
      const duration = `${(s.durationMs / 1000).toFixed(1)}s`;
      const stateBadge = `[${s.state.toUpperCase()}]`.padEnd(12);
      lines.push(`  ${stateBadge} ${s.id.padEnd(20)} ${s.title.padEnd(30)} ${s.progress}% (${duration})`);
    }

    return {
      type: "message",
      text: lines.join("\n"),
    };
  },
};
