import { readFile, writeFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";

export interface UndoEntry {
  path: string;
  content: string | null;
  timestamp: number;
  tool: string;
}

export interface TurnSnapshot {
  id: string;
  timestamp: number;
  entries: UndoEntry[];
  gitHead?: string;
}

const undoStack: UndoEntry[] = [];
const turnStack: TurnSnapshot[] = [];
let currentTurn: TurnSnapshot | null = null;
const MAX_UNDO = 20;
const MAX_TURNS = 20;

/** Capture git HEAD if inside a git repository */
function getGitHeadSafe(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { stdio: "pipe", timeout: 2000 })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/** Begins tracking file modifications for a new turn */
export function startTurnSnapshot(turnId?: string): void {
  // If a turn was active and has entries, push it to turnStack
  if (currentTurn && currentTurn.entries.length > 0) {
    turnStack.push(currentTurn);
    if (turnStack.length > MAX_TURNS) turnStack.shift();
  }

  currentTurn = {
    id: turnId ?? `turn-${Date.now()}`,
    timestamp: Date.now(),
    entries: [],
    gitHead: getGitHeadSafe(),
  };
}

/** Finalizes the current turn snapshot */
export function commitTurnSnapshot(): void {
  if (currentTurn && currentTurn.entries.length > 0) {
    turnStack.push(currentTurn);
    if (turnStack.length > MAX_TURNS) turnStack.shift();
  }
  currentTurn = null;
}

/** Record file state prior to write or edit */
export async function pushUndo(path: string, tool: string): Promise<void> {
  let content: string | null = null;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    // New file — undo will delete it
  }

  const entry: UndoEntry = { path, content, timestamp: Date.now(), tool };
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) {
    undoStack.shift();
  }

  // Also record in active turn if tracking
  if (currentTurn) {
    // Avoid duplicate prior-snapshots for the same file in the same turn
    const exists = currentTurn.entries.some((e) => e.path === path);
    if (!exists) {
      currentTurn.entries.push(entry);
    }
  }
}

/** Revert the single most recent file modification */
export async function performUndo(): Promise<{ path: string; tool: string; deleted?: boolean } | null> {
  const entry = undoStack.pop();
  if (!entry) return null;

  if (entry.content === null) {
    try { await unlink(entry.path); } catch {}
    return { path: entry.path, tool: entry.tool, deleted: true };
  }

  await writeFile(entry.path, entry.content, "utf-8");
  return { path: entry.path, tool: entry.tool };
}

/** Revert all file changes made in the last assistant turn */
export async function performTurnUndo(): Promise<{
  turnId: string;
  revertedCount: number;
  files: string[];
} | null> {
  // Check active turn first if it has modifications, else pop from turnStack
  let turnToRevert: TurnSnapshot | undefined;

  if (currentTurn && currentTurn.entries.length > 0) {
    turnToRevert = currentTurn;
    currentTurn = null;
  } else {
    turnToRevert = turnStack.pop();
  }

  if (!turnToRevert || turnToRevert.entries.length === 0) {
    return null;
  }

  const revertedFiles: string[] = [];

  // Restore files in reverse chronological order
  for (let i = turnToRevert.entries.length - 1; i >= 0; i--) {
    const entry = turnToRevert.entries[i]!;
    if (entry.content === null) {
      try { await unlink(entry.path); } catch {}
    } else {
      await writeFile(entry.path, entry.content, "utf-8");
    }
    revertedFiles.push(entry.path);
  }

  return {
    turnId: turnToRevert.id,
    revertedCount: revertedFiles.length,
    files: revertedFiles,
  };
}

export function getUndoStack(): Array<{ path: string; tool: string; timestamp: number }> {
  return undoStack.map(({ path, tool, timestamp }) => ({ path, tool, timestamp }));
}

export function getTurnStack(): TurnSnapshot[] {
  return [...turnStack];
}

export function hasUndo(): boolean {
  return undoStack.length > 0;
}

export function hasTurnUndo(): boolean {
  return (currentTurn !== null && currentTurn.entries.length > 0) || turnStack.length > 0;
}
