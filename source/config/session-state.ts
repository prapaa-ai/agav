import { readFile, writeFile, unlink } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../providers/types.js";
import { getAgavDir } from "./config.js";
import { ensureDir } from "../utils/fs.js";

interface SessionState {
  messages: Message[];
  model: string;
  provider: string;
  cwd: string;
  savedAt: string;
  clean: boolean;
}

const STATE_FILE = join(getAgavDir(), "session-state.json");

export async function saveSessionState(
  messages: Message[],
  model: string,
  provider: string,
  clean: boolean,
): Promise<void> {
  try {
    await ensureDir(getAgavDir());
    const state: SessionState = {
      messages,
      model,
      provider,
      cwd: process.cwd(),
      savedAt: new Date().toISOString(),
      clean,
    };
    await writeFile(STATE_FILE, JSON.stringify(state));
  } catch {}
}

/** Validate that a parsed object has the expected SessionState shape. */
function isValidSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    Array.isArray(obj.messages) &&
    typeof obj.model === "string" &&
    typeof obj.provider === "string" &&
    typeof obj.cwd === "string" &&
    typeof obj.savedAt === "string" &&
    typeof obj.clean === "boolean"
  );
}

export async function loadSessionState(): Promise<SessionState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(raw);

    // Guard against corrupt or partially-written state files.
    if (!isValidSessionState(state)) {
      try { await unlink(STATE_FILE); } catch {}
      return null;
    }

    // Only resume if it was NOT a clean exit and same cwd
    if (state.clean) return null;
    if (state.cwd !== process.cwd()) return null;

    // Expire stale recovery state so old crashes do not keep reappearing on later launches.
    const age = Date.now() - new Date(state.savedAt).getTime();
    if (age > 60 * 60 * 1000) return null;

    return state;
  } catch {
    // If the file is unreadable or contains invalid JSON, remove it so the
    // next startup does not keep hitting the same corrupt data.
    try { await unlink(STATE_FILE); } catch {}
    return null;
  }
}

export async function clearSessionState(): Promise<void> {
  try {
    await unlink(STATE_FILE);
  } catch {}
}

export async function markCleanExit(): Promise<void> {
  await saveSessionState([], "", "", true);
}

/**
 * Synchronous variant of markCleanExit for use inside `process.on("exit")`
 * handlers where async operations cannot complete before the process tears
 * down.  An incomplete async write leaves a corrupt session-state.json that
 * can trigger a Bun memory-allocator segfault on the next Windows startup.
 */
export function markCleanExitSync(): void {
  try {
    mkdirSync(getAgavDir(), { recursive: true });
    const state: SessionState = {
      messages: [],
      model: "",
      provider: "",
      cwd: process.cwd(),
      savedAt: new Date().toISOString(),
      clean: true,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}
