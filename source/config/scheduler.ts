import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";
import { getAgavDir } from "./config.js";
import { parseCronExpression } from "../background-jobs/schedule/cron.js";
import { ensureDir } from "../utils/fs.js";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
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
  const path = getSchedulerPath();
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(tasks, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
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

export async function updateScheduledTask(
  id: string,
  update: { cron?: string; prompt?: string },
): Promise<ScheduledTask | undefined> {
  const cron = update.cron?.trim();
  const prompt = update.prompt;
  if (cron !== undefined) parseCronExpression(cron);
  if (prompt !== undefined && !prompt.trim()) throw new Error("Prompt must not be empty.");
  if (cron === undefined && prompt === undefined) throw new Error("Specify a cron expression or prompt.");
  const tasks = await loadScheduledTasks();
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) return undefined;
  if (cron !== undefined) task.cron = cron;
  if (prompt !== undefined) task.prompt = prompt;
  await saveTasks(tasks);
  return task;
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
  let fields: ReturnType<typeof parseCronExpression>;
  try {
    fields = parseCronExpression(cron);
  } catch {
    return false;
  }

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    fieldMatches(fields.minute, minute) &&
    fieldMatches(fields.hour, hour) &&
    fieldMatches(fields.dayOfMonth, dayOfMonth) &&
    fieldMatches(fields.month, month) &&
    fieldMatches(fields.dayOfWeek, dayOfWeek)
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    if (part === "*") return true;
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) continue;
      if (range === "*") {
        if (value % step === 0) return true;
      } else {
        const [startText, endText] = range!.split("-");
        const start = Number(startText);
        if (value >= start && (endText === undefined || value <= Number(endText)) &&
            (value - start) % step === 0) return true;
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
