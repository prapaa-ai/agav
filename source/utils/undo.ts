import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import { resolve, normalize } from "node:path";
import { isWithinRoot } from "./path-guard.js";

export type FileAction = "create" | "modify" | "delete" | "rename";

export interface UndoEntry {
  path: string;
  content: string | null;
  mode?: number;
  timestamp: number;
  tool: string;
}

export interface FileSnapshotEntry {
  path: string;
  action: FileAction;
  preTurnContent: string | null;
  preTurnMode?: number;
  oldPath?: string;
  timestamp: number;
  tool: string;
}

export interface TurnSnapshot {
  id: string;
  workspaceRoot: string;
  parentTurnId?: string;
  timestamp: number;
  entries: Map<string, FileSnapshotEntry>;
  committed: boolean;
}

const undoStack: UndoEntry[] = [];
const turnHistory: TurnSnapshot[] = [];
const activeTurnStack: TurnSnapshot[] = [];

const MAX_UNDO = 20;
const MAX_TURNS = 30;

function normalizePath(p: string): string {
  return normalize(resolve(p));
}

// ==========================================
// 1. Turn Lifecycle
// ==========================================

export function startTurnSnapshot(options?: {
  id?: string;
  workspaceRoot?: string;
  parentTurnId?: string;
}): TurnSnapshot {
  const turnId = options?.id ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const workspaceRoot = options?.workspaceRoot ? normalizePath(options.workspaceRoot) : normalizePath(process.cwd());

  const snapshot: TurnSnapshot = {
    id: turnId,
    workspaceRoot,
    parentTurnId: options?.parentTurnId,
    timestamp: Date.now(),
    entries: new Map<string, FileSnapshotEntry>(),
    committed: false,
  };

  activeTurnStack.push(snapshot);
  return snapshot;
}

export function getCurrentTurnSnapshot(): TurnSnapshot | null {
  if (activeTurnStack.length === 0) return null;
  return activeTurnStack[activeTurnStack.length - 1]!;
}

export function commitTurnSnapshot(turnId?: string): TurnSnapshot | null {
  let targetIndex = activeTurnStack.length - 1;
  if (turnId) {
    targetIndex = activeTurnStack.findIndex((t) => t.id === turnId);
  }

  if (targetIndex < 0) return null;

  const [turn] = activeTurnStack.splice(targetIndex, 1);
  if (!turn) return null;

  turn.committed = true;

  // Only store in history if modifications actually occurred
  if (turn.entries.size > 0) {
    turnHistory.push(turn);
    if (turnHistory.length > MAX_TURNS) {
      turnHistory.shift();
    }
  }

  return turn;
}

export function discardTurnSnapshot(turnId?: string): void {
  let targetIndex = activeTurnStack.length - 1;
  if (turnId) {
    targetIndex = activeTurnStack.findIndex((t) => t.id === turnId);
  }
  if (targetIndex >= 0) {
    activeTurnStack.splice(targetIndex, 1);
  }
}

// ==========================================
// 2. Snapshot Recording
// ==========================================

export async function pushUndo(
  filePath: string,
  tool: string,
  options?: { workspaceRoot?: string },
): Promise<void> {
  const absPath = normalizePath(filePath);
  let content: string | null = null;
  let fileMode: number | undefined;

  try {
    content = await readFile(absPath, "utf-8");
    const stats = await stat(absPath);
    fileMode = stats.mode;
  } catch {
    // New file (does not exist yet)
  }

  const legacyEntry: UndoEntry = {
    path: absPath,
    content,
    mode: fileMode,
    timestamp: Date.now(),
    tool,
  };

  undoStack.push(legacyEntry);
  if (undoStack.length > MAX_UNDO) {
    undoStack.shift();
  }

  // Record in current turn snapshot if active
  const currentTurn = getCurrentTurnSnapshot();
  if (currentTurn) {
    // Deduplication within same turn: preserve original pre-turn state
    if (!currentTurn.entries.has(absPath)) {
      currentTurn.entries.set(absPath, {
        path: absPath,
        action: content === null ? "create" : "modify",
        preTurnContent: content,
        preTurnMode: fileMode,
        timestamp: Date.now(),
        tool,
      });
    }
  }
}

export async function recordFileDelete(
  filePath: string,
  tool: string,
  options?: { workspaceRoot?: string },
): Promise<void> {
  const absPath = normalizePath(filePath);
  let content: string | null = null;
  let fileMode: number | undefined;

  try {
    content = await readFile(absPath, "utf-8");
    const stats = await stat(absPath);
    fileMode = stats.mode;
  } catch {
    return; // Already does not exist
  }

  const currentTurn = getCurrentTurnSnapshot();
  if (currentTurn) {
    if (!currentTurn.entries.has(absPath)) {
      currentTurn.entries.set(absPath, {
        path: absPath,
        action: "delete",
        preTurnContent: content,
        preTurnMode: fileMode,
        timestamp: Date.now(),
        tool,
      });
    }
  }

  undoStack.push({
    path: absPath,
    content,
    mode: fileMode,
    timestamp: Date.now(),
    tool,
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

export async function recordFileRename(
  oldPath: string,
  newPath: string,
  tool: string,
  options?: { workspaceRoot?: string },
): Promise<void> {
  const absOld = normalizePath(oldPath);
  const absNew = normalizePath(newPath);

  let content: string | null = null;
  let fileMode: number | undefined;

  try {
    content = await readFile(absOld, "utf-8");
    const stats = await stat(absOld);
    fileMode = stats.mode;
  } catch {
    try {
      content = await readFile(absNew, "utf-8");
      const stats = await stat(absNew);
      fileMode = stats.mode;
    } catch {}
  }

  const currentTurn = getCurrentTurnSnapshot();
  if (currentTurn) {
    if (!currentTurn.entries.has(absNew)) {
      currentTurn.entries.set(absNew, {
        path: absNew,
        action: "rename",
        oldPath: absOld,
        preTurnContent: content,
        preTurnMode: fileMode,
        timestamp: Date.now(),
        tool,
      });
    }
  }

  undoStack.push({
    path: absNew,
    content: null,
    timestamp: Date.now(),
    tool,
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

// ==========================================
// 3. Undo Restoration
// ==========================================

export async function performUndo(): Promise<{
  path: string;
  tool: string;
  deleted?: boolean;
} | null> {
  const entry = undoStack.pop();
  if (!entry) return null;

  if (entry.content === null) {
    try {
      await unlink(entry.path);
    } catch {}
    return { path: entry.path, tool: entry.tool, deleted: true };
  }

  await writeFile(entry.path, entry.content, {
    encoding: "utf-8",
    mode: entry.mode,
  });
  return { path: entry.path, tool: entry.tool };
}

interface PreRestoreBackup {
  path: string;
  exists: boolean;
  content?: string;
  mode?: number;
}

export async function performTurnUndo(options?: {
  workspaceRoot?: string;
  turnId?: string;
}): Promise<{
  turnId: string;
  revertedCount: number;
  files: string[];
} | null> {
  let turnToRevert: TurnSnapshot | undefined;

  if (options?.turnId) {
    const idx = turnHistory.findIndex((t) => t.id === options.turnId);
    if (idx >= 0) {
      turnToRevert = turnHistory.splice(idx, 1)[0];
    }
  } else if (options?.workspaceRoot) {
    const normRoot = normalizePath(options.workspaceRoot);
    for (let i = turnHistory.length - 1; i >= 0; i--) {
      if (turnHistory[i]!.workspaceRoot === normRoot) {
        turnToRevert = turnHistory.splice(i, 1)[0];
        break;
      }
    }
  } else {
    // If an uncommitted active turn has modifications, revert it
    const active = getCurrentTurnSnapshot();
    if (active && active.entries.size > 0) {
      activeTurnStack.pop();
      turnToRevert = active;
    } else {
      turnToRevert = turnHistory.pop();
    }
  }

  if (!turnToRevert || turnToRevert.entries.size === 0) {
    return null;
  }

  const entries = Array.from(turnToRevert.entries.values());

  // 1. VALIDATION PHASE: Workspace boundary & snapshot integrity
  const effectiveRoot = options?.workspaceRoot
    ? normalizePath(options.workspaceRoot)
    : turnToRevert.workspaceRoot;

  for (const entry of entries) {
    if (!entry.path || typeof entry.path !== "string") {
      throw new Error(`Snapshot corruption: invalid path in turn snapshot [${turnToRevert.id}].`);
    }

    if (!isWithinRoot(effectiveRoot, entry.path)) {
      throw new Error(
        `Security boundary violation: cannot restore ${entry.path} outside authorized workspace root (${effectiveRoot}).`,
      );
    }

    if (entry.oldPath && !isWithinRoot(effectiveRoot, entry.oldPath)) {
      throw new Error(
        `Security boundary violation: cannot restore rename target ${entry.oldPath} outside authorized workspace root (${effectiveRoot}).`,
      );
    }
  }

  // 2. PRE-RESTORE BACKUP PHASE (for atomic rollback if any restoration step fails)
  const backups = new Map<string, PreRestoreBackup>();
  for (const entry of entries) {
    const checkPaths = [entry.path];
    if (entry.oldPath) checkPaths.push(entry.oldPath);

    for (const p of checkPaths) {
      if (!backups.has(p)) {
        try {
          const currentContent = await readFile(p, "utf-8");
          const stats = await stat(p);
          backups.set(p, { path: p, exists: true, content: currentContent, mode: stats.mode });
        } catch {
          backups.set(p, { path: p, exists: false });
        }
      }
    }
  }

  // 3. ATOMIC RESTORATION PHASE
  const restoredPaths: string[] = [];

  try {
    // Restore in reverse order of modifications
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;

      if (entry.action === "create" || entry.preTurnContent === null) {
        // File was created during the turn: delete it
        try {
          await unlink(entry.path);
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
        restoredPaths.push(entry.path);
      } else if (entry.action === "rename" && entry.oldPath) {
        // Remove the new path and restore the old path
        try {
          await unlink(entry.path);
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
        }
        await writeFile(entry.oldPath, entry.preTurnContent, {
          encoding: "utf-8",
          mode: entry.preTurnMode,
        });
        restoredPaths.push(entry.oldPath);
      } else {
        // File was modified or deleted: restore pre-turn content and mode
        await writeFile(entry.path, entry.preTurnContent, {
          encoding: "utf-8",
          mode: entry.preTurnMode,
        });
        restoredPaths.push(entry.path);
      }
    }
  } catch (restoreErr) {
    // ATOMIC ROLLBACK: restore all already-restored files back to their post-turn state
    for (const p of restoredPaths) {
      const b = backups.get(p);
      if (b) {
        try {
          if (!b.exists) {
            await unlink(p);
          } else if (b.content !== undefined) {
            await writeFile(p, b.content, { encoding: "utf-8", mode: b.mode });
          }
        } catch {}
      }
    }

    throw new Error(
      `Atomic turn undo failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}. All file modifications have been rolled back to prevent partial corruption.`,
    );
  }

  return {
    turnId: turnToRevert.id,
    revertedCount: restoredPaths.length,
    files: restoredPaths,
  };
}

// ==========================================
// 4. Inspect & Drain State
// ==========================================

export function getUndoStack(): Array<{ path: string; tool: string; timestamp: number }> {
  return undoStack.map(({ path, tool, timestamp }) => ({ path, tool, timestamp }));
}

export function getTurnStack(workspaceRoot?: string): TurnSnapshot[] {
  if (!workspaceRoot) return [...turnHistory];
  const normRoot = normalizePath(workspaceRoot);
  return turnHistory.filter((t) => t.workspaceRoot === normRoot);
}

export function hasUndo(): boolean {
  return undoStack.length > 0;
}

export function hasTurnUndo(workspaceRoot?: string): boolean {
  if (!workspaceRoot) {
    const active = getCurrentTurnSnapshot();
    return (active !== null && active.entries.size > 0) || turnHistory.length > 0;
  }
  const normRoot = normalizePath(workspaceRoot);
  const active = getCurrentTurnSnapshot();
  if (active && active.workspaceRoot === normRoot && active.entries.size > 0) {
    return true;
  }
  return turnHistory.some((t) => t.workspaceRoot === normRoot);
}

export function drainUndoState(): void {
  undoStack.length = 0;
  turnHistory.length = 0;
  activeTurnStack.length = 0;
}
