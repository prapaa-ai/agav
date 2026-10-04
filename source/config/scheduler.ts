import { readFile, writeFile } from "node:fs/promises";
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
  kind?: "prompt" | "process";
  command?: string;
  cwd?: string;
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
  await writeFile(getSchedulerPath(), JSON.stringify(tasks, null, 2));
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

function findTask(tasks: ScheduledTask[], idOrPrefix: string): ScheduledTask | undefined {
  return tasks.find((t) => t.id === idOrPrefix) ?? tasks.find((t) => t.id.startsWith(idOrPrefix));
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
  if (parts.length !== 5) return false;

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
