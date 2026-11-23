import { readFile, writeFile, unlink } from "node:fs/promises";

interface UndoEntry {
  path: string;
  content: string | null;
  timestamp: number;
  tool: string;
}

const undoStack: UndoEntry[] = [];
const MAX_UNDO = 20;

export async function pushUndo(path: string, tool: string): Promise<void> {
  let content: string | null = null;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    // New file — undo will delete it
  }
  undoStack.push({ path, content, timestamp: Date.now(), tool });
  if (undoStack.length > MAX_UNDO) {
    undoStack.shift();
  }
}

export async function performUndo(): Promise<{ path: string; tool: string; deleted?: boolean } | null> {
  return performUndoAt(undoStack.length - 1);
}

/**
 * Revert exactly the entry at `index` (0 = oldest) and remove only that
 * entry from the stack, leaving newer entries untouched. Returns null when
 * the index is out of range, without mutating any file.
 */
export async function performUndoAt(index: number): Promise<{ path: string; tool: string; deleted?: boolean } | null> {
  if (!Number.isInteger(index) || index < 0 || index >= undoStack.length) return null;
  const [entry] = undoStack.splice(index, 1);
  if (!entry) return null;

  if (entry.content === null) {
    try { await unlink(entry.path); } catch {}
    return { path: entry.path, tool: entry.tool, deleted: true };
  }

  await writeFile(entry.path, entry.content, "utf-8");
  return { path: entry.path, tool: entry.tool };
}

export function getUndoStack(): Array<{ path: string; tool: string; timestamp: number }> {
  return undoStack.map(({ path, tool, timestamp }) => ({ path, tool, timestamp }));
}

export function hasUndo(): boolean {
  return undoStack.length > 0;
}
