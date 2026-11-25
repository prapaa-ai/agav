import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";
import { getAgavDir, withConfigLock } from "./config.js";
import { parseCronExpression } from "../background-jobs/schedule/cron.js";

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

// Writers must distinguish a missing file from an unreadable or corrupt one;
// treating either of the latter as an empty list could overwrite saved tasks.
async function readTasks(): Promise<ScheduledTask[]> {
  let raw: string;
  try {
    raw = await readFile(getSchedulerPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const tasks = JSON.parse(raw);
  if (!Array.isArray(tasks)) throw new Error("Expected a list of scheduled tasks in scheduled-tasks.json.");
  return tasks;
}

export async function loadScheduledTasks(): Promise<ScheduledTask[]> {
  try {
    return await readTasks();
  } catch {
    return [];
  }
}

// Called only while holding the config lock. Readers see old or new complete JSON.
async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
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

function validatePrompt(prompt: string): void {
  if (!prompt.trim()) throw new Error("Prompt must not be empty.");
}

export async function addScheduledTask(
  name: string,
  cron: string,
  prompt: string,
): Promise<ScheduledTask> {
  parseCronExpression(cron);
  validatePrompt(prompt);
  return withConfigLock(async () => {
    const tasks = await readTasks();
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
  });
}

function findTask(tasks: ScheduledTask[], idOrPrefix: string): ScheduledTask | undefined {
  return tasks.find((t) => t.id === idOrPrefix) ?? tasks.find((t) => t.id.startsWith(idOrPrefix));
}

function findTaskForUpdate(tasks: ScheduledTask[], idOrPrefix: string): ScheduledTask | undefined {
  const exact = tasks.find((t) => t.id === idOrPrefix);
  if (exact || !idOrPrefix) return exact;
  const matches = tasks.filter((t) => t.id.startsWith(idOrPrefix));
  if (matches.length > 1) {
    throw new Error(`Ambiguous task ID prefix "${idOrPrefix}". Use the full task ID.`);
  }
  return matches[0];
}

export async function removeScheduledTask(id: string): Promise<boolean> {
  return withConfigLock(async () => {
    const tasks = await readTasks();
    const task = findTask(tasks, id);
    if (!task) return false;
    const filtered = tasks.filter((t) => t.id !== task.id);
    await saveTasks(filtered);
    return true;
  });
}

export async function updateScheduledTask(
  id: string,
  update: { cron?: string; prompt?: string },
): Promise<ScheduledTask | undefined> {
  const cron = update.cron?.trim();
  const prompt = update.prompt;
  if (cron !== undefined) parseCronExpression(cron);
  if (prompt !== undefined) validatePrompt(prompt);
  if (cron === undefined && prompt === undefined) throw new Error("Specify a cron expression or prompt.");
  return withConfigLock(async () => {
    const tasks = await readTasks();
    const task = findTaskForUpdate(tasks, id);
    if (!task) return undefined;
    if (cron !== undefined) task.cron = cron;
    if (prompt !== undefined) task.prompt = prompt;
    await saveTasks(tasks);
    return task;
  });
}

export async function setTaskEnabled(id: string, enabled: boolean): Promise<boolean> {
  return withConfigLock(async () => {
    const tasks = await readTasks();
    const task = findTask(tasks, id);
    if (!task) return false;
    task.enabled = enabled;
    await saveTasks(tasks);
    return true;
  });
}

export async function markTaskRun(id: string): Promise<void> {
  await withConfigLock(async () => {
    const tasks = await readTasks();
    const task = findTask(tasks, id);
    if (task) {
      task.lastRunAt = new Date().toISOString();
      await saveTasks(tasks);
    }
  });
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
    fieldMatches(fields.dayOfMonth, dayOfMonth, 1) &&
    fieldMatches(fields.month, month, 1) &&
    fieldMatches(fields.dayOfWeek, dayOfWeek)
  );
}

function fieldMatches(field: string, value: number, min = 0): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    if (part === "*") return true;
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) continue;
      if (range === "*") {
        if (value >= min && (value - min) % step === 0) return true;
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
