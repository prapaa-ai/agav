import { readFile, writeFile, unlink } from "node:fs/promises";
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

export async function loadSessionState(): Promise<SessionState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as SessionState;

    // Only resume if it was NOT a clean exit and same cwd
    if (state.clean) return null;
    if (state.cwd !== process.cwd()) return null;

    // Expire stale recovery state so old crashes do not keep reappearing on later launches.
    const age = Date.now() - new Date(state.savedAt).getTime();
    if (age > 60 * 60 * 1000) return null;

    return state;
  } catch {
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
