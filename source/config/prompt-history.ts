import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const HISTORY_PATH = join(homedir(), ".agav", "prompt-history.json");
const MAX_ENTRIES = 500;

export async function loadPromptHistory(): Promise<string[]> {
  try {
    const data = JSON.parse(await readFile(HISTORY_PATH, "utf-8"));
    if (Array.isArray(data)) return data.filter((e): e is string => typeof e === "string");
  } catch {}
  return [];
}

export async function savePromptHistory(history: string[]): Promise<void> {
  const trimmed = history.slice(-MAX_ENTRIES);
  try {
    await mkdir(dirname(HISTORY_PATH), { recursive: true });
    await writeFile(HISTORY_PATH, JSON.stringify(trimmed), "utf-8");
  } catch {}
}
