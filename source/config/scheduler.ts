import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";
import { getAgavDir } from "./config.js";
import { ensureDir } from "../utils/fs.js";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  kind?: "prompt" | "process" | "workflow";
  command?: string;
  cwd?: string;
  /** Workflow name or path, when `kind` is `workflow`. */
  workflow?: string;
  /** Serialized inputs for the run. */
  input?: Record<string, unknown>;
  /**
   * The most recent minute this task fired, as `minutesSinceMidnight`.
   *
   * `lastRunAt` records when a run *started*; this records which scheduled
   * minute was consumed. Keeping them apart is what lets a task that was down
   * at 03:00 be recognised as missed rather than silently skipped.
   */
  lastFiredMinute?: number;
  /**
   * Local day the consumed minute belonged to, as days since the epoch.
   *
   * `lastFiredMinute` is time-of-day only, so it cannot distinguish "fired this
   * minute" from "fired at the same minute yesterday". Pairing it with the day
   * keeps a daily task due again the next day instead of being skipped.
   */
  lastFiredDay?: number;
  /**
   * Refuse to start a new run while the previous one is still going.
   *
   * Default true. Without it, a five-minute cron on a twenty-minute workflow
   * starts four concurrent runs against the same external systems.
   */
  skipIfRunning?: boolean;
  /**
   * Catch up a fire missed while nothing was running, within this many minutes.
   *
   * Bounded on purpose: a machine off for a week should not fire a hundred
   * times on restart. Unset means missed fires are only recorded, not replayed.
   */
  catchUpWithinMinutes?: number;
  /** Minutes whose fires were skipped because the task was not running. */
  missedRuns?: number;
  /** Last reason a fire was skipped, for operator visibility. */
  lastSkipReason?: string;
}

function getSchedulerPath(): string {
  return join(getAgavDir(), "scheduled-tasks.json");
}

export async function loadScheduledTasks(): Promise<ScheduledTask[]> {
  try {
    const data = JSON.parse(await readFile(getSchedulerPath(), "utf-8"));
    if (Array.isArray(data)) return data;
  } catch {}
  return [];
}

async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  await ensureDir(getAgavDir());
  // Write to a temp file and rename, so a reader never sees a half-written
  // array and two writers cannot silently clobber each other.
  const path = getSchedulerPath();
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(tasks, null, 2), "utf-8");
  await rename(tmp, path);
}

export async function addScheduledTask(
  name: string,
  cron: string,
  prompt: string,
): Promise<ScheduledTask> {
  const tasks = await loadScheduledTasks();
  const task: ScheduledTask = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    prompt,
    cron,
    enabled: true,
    createdAt: new Date().toISOString(),
    kind: "prompt",
  };
  tasks.push(task);
  await saveTasks(tasks);
  return task;
}

export async function addScheduledProcessTask(
  name: string,
  cron: string,
  command: string,
  cwd?: string,
): Promise<ScheduledTask> {
  const tasks = await loadScheduledTasks();
  const task: ScheduledTask = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    prompt: command,
    command,
    cwd,
    cron,
    enabled: true,
    createdAt: new Date().toISOString(),
    kind: "process",
  };
  tasks.push(task);
  await saveTasks(tasks);
  return task;
}

export async function addScheduledWorkflowTask(
  name: string,
  cron: string,
  workflow: string,
  options: { input?: Record<string, unknown>; cwd?: string; skipIfRunning?: boolean; catchUpWithinMinutes?: number } = {},
): Promise<ScheduledTask> {
  const tasks = await loadScheduledTasks();
  const task: ScheduledTask = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    // `prompt` is required by the schema; the workflow is the meaningful field
    // here, and mirroring it keeps older readers working.
    prompt: workflow,
    workflow,
    cron,
    enabled: true,
    createdAt: new Date().toISOString(),
    kind: "workflow",
    // Overlapping runs are refused by default: two runs of the same workflow
    // against the same external systems is the failure mode that matters.
    skipIfRunning: options.skipIfRunning ?? true,
    ...(options.input ? { input: options.input } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.catchUpWithinMinutes !== undefined
      ? { catchUpWithinMinutes: options.catchUpWithinMinutes }
      : {}),
  };
  tasks.push(task);
  await saveTasks(tasks);
  return task;
}

function findTask(tasks: ScheduledTask[], idOrPrefix: string): ScheduledTask | undefined {
  return tasks.find((t) => t.id === idOrPrefix) ?? tasks.find((t) => t.id.startsWith(idOrPrefix));
}

/** Insert or replace a single task, leaving the rest of the file untouched. */
export async function saveScheduledTask(task: ScheduledTask): Promise<ScheduledTask> {
  const tasks = await loadScheduledTasks();
  const index = tasks.findIndex((entry) => entry.id === task.id);
  if (index === -1) tasks.push(task);
  else tasks[index] = task;
  await saveTasks(tasks);
  return task;
}

export async function removeScheduledTask(id: string): Promise<boolean> {
  const tasks = await loadScheduledTasks();
  const task = findTask(tasks, id);
  if (!task) return false;
  const filtered = tasks.filter((t) => t.id !== task.id);
  await saveTasks(filtered);
  return true;
}

export async function setTaskEnabled(id: string, enabled: boolean): Promise<boolean> {
  const tasks = await loadScheduledTasks();
  const task = findTask(tasks, id);
  if (!task) return false;
  task.enabled = enabled;
  await saveTasks(tasks);
  return true;
}

export async function markTaskRun(id: string): Promise<void> {
  const tasks = await loadScheduledTasks();
  const task = findTask(tasks, id);
  if (task) {
    task.lastRunAt = new Date().toISOString();
    await saveTasks(tasks);
  }
}

export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${cron}": expected 5 fields, got ${parts.length}`);
  }

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    fieldMatches(parts[0]!, minute, 0, 59) &&
    fieldMatches(parts[1]!, hour, 0, 23) &&
    fieldMatches(parts[2]!, dayOfMonth, 1, 31) &&
    fieldMatches(parts[3]!, month, 1, 12) &&
    fieldMatches(parts[4]!, dayOfWeek, 0, 6)
  );
}

function fieldMatches(field: string, value: number, _min: number, _max: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) continue;
      if (range === "*") {
        if (value % step === 0) return true;
      } else {
        const start = parseInt(range!, 10);
        if (!isNaN(start) && value >= start && (value - start) % step === 0) return true;
      }
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true;
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num === value) return true;
    }
  }

  return false;
}
