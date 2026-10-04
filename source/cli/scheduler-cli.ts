import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import {
  addScheduledTask,
  addScheduledProcessTask,
  addScheduledWorkflowTask,
  cronMatches,
  loadScheduledTasks,
  removeScheduledTask,
  setTaskEnabled,
  type ScheduledTask,
} from "../config/scheduler.js";
import { formatScheduleLine, tick } from "../workflows/schedule-run.js";
import { loadWorkflow } from "../workflows/loader.js";
import { validateWorkflow } from "../workflows/validator.js";
import { ToolRegistry } from "../tools/registry.js";
import { listWorkflowJobs, isWorkflowJobAlive } from "../workflows/jobs.js";
import { daemonPaths, readDaemonRecord, runDaemon, stopDaemon } from "../workflows/scheduler-daemon.js";

/**
 * `agav scheduler <command>`
 *
 * The tick logic lives in `source/workflows/schedule-run.ts`, shared with the
 * interactive ticker, so a headless invocation and a running session apply
 * identical rules. This file is only argument handling and output.
 */

function printUsage(): void {
  console.log(`Usage: agav scheduler <action>

  list                          List scheduled tasks and their last outcome
  add <cron> <workflow>         Schedule a workflow run
  tick                          Evaluate the schedule once, starting anything due
  remove <id>                   Remove a scheduled task
  enable <id> / disable <id>    Toggle a scheduled task
  daemon start                  Run the scheduler with no interactive session
  daemon stop                   Stop a running scheduler daemon
  daemon status                 Report whether a daemon is running

Workflow scheduling runs detached: the workflow keeps going after the terminal
that started it closes, and reports on completion through agav notifications.

Without a daemon the schedule only fires while an interactive session is open.
Run \`agav scheduler daemon start\` to evaluate every 30s with no session attached.`);
}

/** Take the next argument, treating a leading dash as a missing value. */
function take(args: string[], index: number): string | undefined {
  const value = args[index];
  return value && !value.startsWith("-") ? value : undefined;
}

async function readInput(args: string[], from: number): Promise<Record<string, unknown> | undefined> {
  const flag = args.indexOf("--input-json", from);
  if (flag === -1) return undefined;
  const raw = args[flag + 1];
  if (!raw) throw new Error("--input-json requires a JSON object");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function intFlag(args: string[], name: string): number | undefined {
  const flag = args.indexOf(name);
  if (flag === -1) return undefined;
  const value = Number.parseInt(args[flag + 1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

/** Reject a workflow that does not exist or does not validate, before scheduling it. */
async function requireRunnableWorkflow(target: string): Promise<string> {
  let definition;
  try {
    definition = (await loadWorkflow(target)).definition;
  } catch {
    throw new Error(`Workflow "${target}" not found.`);
  }
  const result = await validateWorkflow(definition, {
    hasTool: (name: string) => new ToolRegistry().list().some((t) => t.schema.name === name),
  });
  if (!result.ok) {
    throw new Error(`Workflow "${target}" is not runnable:\n  ${result.issues.map((i) => `${i.path}: ${i.message}`).join("\n  ")}`);
  }
  return definition.name;
}

export async function runSchedulerCommand(command: string | undefined, args: string[]): Promise<number> {
  try {
    if (!command || command === "help") {
      printUsage();
      return 0;
    }

    if (command === "list") {
      const tasks = await loadScheduledTasks();
      if (tasks.length === 0) {
        console.log("No scheduled tasks.");
        return 0;
      }
      for (const task of tasks) console.log(formatScheduleLine(task));

      // Surface anything currently detached, so a stuck run is visible here.
      const live = (await listWorkflowJobs()).filter((job) => isWorkflowJobAlive(job));
      if (live.length > 0) {
        console.log(`\nDetached workflow runs in flight: ${live.length}`);
        for (const job of live) console.log(`  ${job.id}  run=${job.runId}  ${job.target}`);
      }
      return 0;
    }

    if (command === "add") {
      const cron = take(args, 0);
      const target = take(args, 1);
      if (!cron || !target) {
        printUsage();
        return 1;
      }
      // Validate now rather than discovering a typo at 03:00.
      try {
        cronMatches(cron, new Date());
      } catch (err) {
        console.error(`Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      const name = await requireRunnableWorkflow(target);
      const input = await readInput(args, 2);
      const catchUpWithinMinutes = intFlag(args, "--catch-up");
      // Only an explicit --cwd sets it. A positional argument is a stray value,
      // not a directory, and reading one here put the cron expression into the
      // job's working directory.
      const cwdIndex = args.indexOf("--cwd");
      const cwd = cwdIndex >= 0 ? take(args, cwdIndex + 1) : undefined;
      const task: ScheduledTask = await addScheduledWorkflowTask(name, cron, target, {
        ...(input ? { input } : {}),
        ...(catchUpWithinMinutes !== undefined ? { catchUpWithinMinutes } : {}),
        ...(cwd ? { cwd } : {}),
      });
      console.log(`Scheduled workflow "${task.name}" (${task.id}) · cron ${task.cron}`);
      console.log(`  Runs detached and reports on completion. Overlapping runs are refused by default.`);
      return 0;
    }

    if (command === "tick") {
      // A one-shot tick, for cron or Task Scheduler on the host. Identical rules
      // to the interactive ticker: the decision layer and the launch are shared,
      // so neither path can drift from the other.
      const decisions = await tick({
        report: (message, isError) => console.log(`${isError ? "!" : "-"} ${message}`),
      });
      const fired = decisions.filter((d) => d.fire).length;
      console.log(`Evaluated ${decisions.length} task(s); ${fired} fired.`);
      return 0;
    }

    if (command === "remove" || command === "rm") {
      const id = take(args, 0);
      if (!id) {
        printUsage();
        return 1;
      }
      return (await removeScheduledTask(id)) ? (console.log(`Removed ${id}.`), 0) : (console.error(`No task matching ${id}.`), 1);
    }

    if (command === "enable" || command === "disable") {
      const id = take(args, 0);
      if (!id) {
        printUsage();
        return 1;
      }
      const ok = await setTaskEnabled(id, command === "enable");
      return ok ? (console.log(`${command}d ${id}.`), 0) : (console.error(`No task matching ${id}.`), 1);
    }

    if (command === "daemon") {
      const action = take(args, 0);

      if (action === "start") {
        const paths = daemonPaths();
        // Report an existing daemon plainly rather than starting a second one.
        const existing = await readDaemonRecord(paths);
        if (existing) {
          console.log(`Scheduler daemon already running (pid ${existing.pid}, since ${existing.startedAt}).`);
          return 0;
        }
        console.log("Starting scheduler daemon. Press Ctrl+C to stop.");
        // Blocks until stopped, so the daemon stays the foreground process.
        await runDaemon({ paths });
        return 0;
      }

      if (action === "stop") {
        const stopped = await stopDaemon(daemonPaths());
        return stopped
          ? (console.log(`Signalled scheduler daemon (pid ${stopped.pid}).`), 0)
          : (console.log("No scheduler daemon is running."), 0);
      }

      if (action === "status") {
        const record = await readDaemonRecord(daemonPaths());
        if (!record) {
          console.log("Scheduler daemon: not running.");
          console.log("  Schedules fire while an interactive session is open, or while a daemon runs.");
          return 0;
        }
        console.log(`Scheduler daemon: running (pid ${record.pid}).`);
        console.log(`  Started ${record.startedAt}`);
        return 0;
      }

      printUsage();
      return 1;
    }
    printUsage();
    return 1;
  } catch (err) {
    console.error(`Scheduler command failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
