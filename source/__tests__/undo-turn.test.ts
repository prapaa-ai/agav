import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTurnSnapshot,
  commitTurnSnapshot,
  discardTurnSnapshot,
  pushUndo,
  recordFileDelete,
  recordFileRename,
  performUndo,
  performTurnUndo,
  hasUndo,
  hasTurnUndo,
  getUndoStack,
  getTurnStack,
  drainUndoState,
  getCurrentTurnSnapshot,
} from "../utils/undo.js";
import { undoCommand } from "../commands/undo.js";

describe("P1.2 Atomic Turn Snapshots & Multi-File /undo turn", () => {
  let testDir: string;
  let otherDir: string;

  beforeEach(async () => {
    drainUndoState();
    testDir = await mkdtemp(join(tmpdir(), "agav-turn-undo-test-"));
    otherDir = await mkdtemp(join(tmpdir(), "agav-turn-undo-other-"));
  });

  afterEach(async () => {
    drainUndoState();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {}
    try {
      await rm(otherDir, { recursive: true, force: true });
    } catch {}
  });

  // 1. One-file edit undo
  it("1. restores single file modified in a turn", async () => {
    const file = join(testDir, "single.txt");
    await writeFile(file, "original content", "utf-8");

    startTurnSnapshot({ id: "turn-1", workspaceRoot: testDir });
    await pushUndo(file, "edit_file");
    await writeFile(file, "modified content", "utf-8");
    commitTurnSnapshot("turn-1");

    expect(await readFile(file, "utf-8")).toBe("modified content");

    const result = await performTurnUndo({ workspaceRoot: testDir });
    expect(result).not.toBeNull();
    expect(result?.revertedCount).toBe(1);
    expect(await readFile(file, "utf-8")).toBe("original content");
  });

  // 2. Multi-file edit undo
  it("2. restores multiple files edited in a single turn atomically", async () => {
    const fileA = join(testDir, "a.txt");
    const fileB = join(testDir, "b.txt");
    const fileC = join(testDir, "c.txt");

    await writeFile(fileA, "orig A", "utf-8");
    await writeFile(fileB, "orig B", "utf-8");
    await writeFile(fileC, "orig C", "utf-8");

    startTurnSnapshot({ id: "turn-multi", workspaceRoot: testDir });
    await pushUndo(fileA, "edit_file");
    await writeFile(fileA, "new A", "utf-8");
    await pushUndo(fileB, "edit_file");
    await writeFile(fileB, "new B", "utf-8");
    await pushUndo(fileC, "edit_file");
    await writeFile(fileC, "new C", "utf-8");
    commitTurnSnapshot("turn-multi");

    expect(await readFile(fileA, "utf-8")).toBe("new A");
    expect(await readFile(fileB, "utf-8")).toBe("new B");
    expect(await readFile(fileC, "utf-8")).toBe("new C");

    const result = await performTurnUndo({ workspaceRoot: testDir });
    expect(result?.revertedCount).toBe(3);

    expect(await readFile(fileA, "utf-8")).toBe("orig A");
    expect(await readFile(fileB, "utf-8")).toBe("orig B");
    expect(await readFile(fileC, "utf-8")).toBe("orig C");
  });

  // 3. File creation and undo
  it("3. unlinks newly created files upon turn undo", async () => {
    const createdFile = join(testDir, "created.txt");

    startTurnSnapshot({ id: "turn-create", workspaceRoot: testDir });
    await pushUndo(createdFile, "write_file");
    await writeFile(createdFile, "created content", "utf-8");
    commitTurnSnapshot("turn-create");

    expect(await readFile(createdFile, "utf-8")).toBe("created content");

    const result = await performTurnUndo({ workspaceRoot: testDir });
    expect(result?.revertedCount).toBe(1);

    let exists = true;
    try {
      await readFile(createdFile, "utf-8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  // 4. File deletion and undo
  it("4. recreates deleted files with original content and mode", async () => {
    const file = join(testDir, "to-delete.txt");
    await writeFile(file, "must be preserved", "utf-8");

    startTurnSnapshot({ id: "turn-delete", workspaceRoot: testDir });
    await recordFileDelete(file, "shell");
    await rm(file, { force: true });
    commitTurnSnapshot("turn-delete");

    let exists = true;
    try {
      await readFile(file, "utf-8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    const result = await performTurnUndo({ workspaceRoot: testDir });
    expect(result?.revertedCount).toBe(1);
    expect(await readFile(file, "utf-8")).toBe("must be preserved");
  });

  // 5. File rename and undo
  it("5. inverts file renames: removes new path and restores old path", async () => {
    const oldPath = join(testDir, "old-name.txt");
    const newPath = join(testDir, "new-name.txt");
    await writeFile(oldPath, "rename me", "utf-8");

    startTurnSnapshot({ id: "turn-rename", workspaceRoot: testDir });
    await recordFileRename(oldPath, newPath, "shell");
    await rm(oldPath);
    await writeFile(newPath, "rename me", "utf-8");
    commitTurnSnapshot("turn-rename");

    const result = await performTurnUndo({ workspaceRoot: testDir });
    expect(result?.revertedCount).toBe(1);

    // Old path restored
    expect(await readFile(oldPath, "utf-8")).toBe("rename me");
    // New path removed
    let newExists = true;
    try {
      await readFile(newPath, "utf-8");
    } catch {
      newExists = false;
    }
    expect(newExists).toBe(false);
  });

  // 6. Mixed create/edit/delete in one turn
  it("6. atomically handles mixed create, edit, and delete in a single turn", async () => {
    const existingFile = join(testDir, "existing.txt");
    const deletedFile = join(testDir, "deleted.txt");
    const createdFile = join(testDir, "new.txt");

    await writeFile(existingFile, "original existing", "utf-8");
    await writeFile(deletedFile, "original deleted", "utf-8");

    startTurnSnapshot({ id: "turn-mixed", workspaceRoot: testDir });
    // Edit existing
    await pushUndo(existingFile, "edit_file");
    await writeFile(existingFile, "modified existing", "utf-8");
    // Delete one
    await recordFileDelete(deletedFile, "shell");
    await rm(deletedFile);
    // Create new
    await pushUndo(createdFile, "write_file");
    await writeFile(createdFile, "new file content", "utf-8");

    commitTurnSnapshot("turn-mixed");

    // Perform turn undo
    const result = await performTurnUndo({ workspaceRoot: testDir });
    expect(result?.revertedCount).toBe(3);

    expect(await readFile(existingFile, "utf-8")).toBe("original existing");
    expect(await readFile(deletedFile, "utf-8")).toBe("original deleted");

    let newExists = true;
    try {
      await readFile(createdFile, "utf-8");
    } catch {
      newExists = false;
    }
    expect(newExists).toBe(false);
  });

  // 7. Failed turn with no committed snapshot
  it("7. discards uncommitted/failed turns so they leave no snapshot in history", async () => {
    const file = join(testDir, "uncommitted.txt");
    await writeFile(file, "safe content", "utf-8");

    startTurnSnapshot({ id: "turn-failed", workspaceRoot: testDir });
    await pushUndo(file, "edit_file");
    await writeFile(file, "corrupted content", "utf-8");

    // Loop aborts or errors out -> discard
    discardTurnSnapshot("turn-failed");

    expect(getTurnStack(testDir)).toHaveLength(0);
    expect(hasTurnUndo(testDir)).toBe(false);
  });

  // 8. Multiple sequential turn snapshots
  it("8. records multiple sequential turns and reverts them in LIFO order", async () => {
    const file = join(testDir, "seq.txt");
    await writeFile(file, "v0", "utf-8");

    // Turn 1
    startTurnSnapshot({ id: "turn-1", workspaceRoot: testDir });
    await pushUndo(file, "edit_file");
    await writeFile(file, "v1", "utf-8");
    commitTurnSnapshot("turn-1");

    // Turn 2
    startTurnSnapshot({ id: "turn-2", workspaceRoot: testDir });
    await pushUndo(file, "edit_file");
    await writeFile(file, "v2", "utf-8");
    commitTurnSnapshot("turn-2");

    expect(getTurnStack(testDir)).toHaveLength(2);
    expect(await readFile(file, "utf-8")).toBe("v2");

    // Undo Turn 2
    const undo2 = await performTurnUndo({ workspaceRoot: testDir });
    expect(undo2?.turnId).toBe("turn-2");
    expect(await readFile(file, "utf-8")).toBe("v1");

    // Undo Turn 1
    const undo1 = await performTurnUndo({ workspaceRoot: testDir });
    expect(undo1?.turnId).toBe("turn-1");
    expect(await readFile(file, "utf-8")).toBe("v0");
  });

  // 9. Undoing only the latest turn
  it("9. undoes only the latest turn without corrupting earlier turns", async () => {
    const file1 = join(testDir, "file1.txt");
    const file2 = join(testDir, "file2.txt");

    await writeFile(file1, "t1-orig", "utf-8");
    await writeFile(file2, "t2-orig", "utf-8");

    // Turn 1 touches file1
    startTurnSnapshot({ id: "turn-1", workspaceRoot: testDir });
    await pushUndo(file1, "edit_file");
    await writeFile(file1, "t1-mod", "utf-8");
    commitTurnSnapshot("turn-1");

    // Turn 2 touches file2
    startTurnSnapshot({ id: "turn-2", workspaceRoot: testDir });
    await pushUndo(file2, "edit_file");
    await writeFile(file2, "t2-mod", "utf-8");
    commitTurnSnapshot("turn-2");

    // Undo only Turn 2
    await performTurnUndo({ workspaceRoot: testDir });

    // file2 is restored, file1 stays modified
    expect(await readFile(file2, "utf-8")).toBe("t2-orig");
    expect(await readFile(file1, "utf-8")).toBe("t1-mod");
  });

  // 10. Nested/subagent turn behavior
  it("10. isolates nested subagent turns without clobbering parent turn state", async () => {
    const parentFile = join(testDir, "parent.txt");
    const subagentFile = join(testDir, "subagent.txt");

    await writeFile(parentFile, "parent initial", "utf-8");
    await writeFile(subagentFile, "subagent initial", "utf-8");

    // Parent turn begins
    const parentSnapshot = startTurnSnapshot({ id: "parent-turn", workspaceRoot: testDir });
    await pushUndo(parentFile, "edit_file");
    await writeFile(parentFile, "parent modified", "utf-8");

    // Subagent spawned: starts child turn
    const childSnapshot = startTurnSnapshot({
      id: "child-turn",
      workspaceRoot: testDir,
      parentTurnId: parentSnapshot.id,
    });
    expect(getCurrentTurnSnapshot()?.id).toBe("child-turn");

    await pushUndo(subagentFile, "edit_file");
    await writeFile(subagentFile, "subagent modified", "utf-8");
    commitTurnSnapshot("child-turn");

    // Current turn returns to parent
    expect(getCurrentTurnSnapshot()?.id).toBe("parent-turn");

    // Parent completes more work
    await writeFile(parentFile, "parent modified again", "utf-8");
    commitTurnSnapshot("parent-turn");

    // Verify subagent turn is separate from parent turn
    const history = getTurnStack(testDir);
    expect(history.map((h) => h.id)).toEqual(["child-turn", "parent-turn"]);

    // Revert parent turn first
    const pUndo = await performTurnUndo({ workspaceRoot: testDir });
    expect(pUndo?.turnId).toBe("parent-turn");
    expect(await readFile(parentFile, "utf-8")).toBe("parent initial");
    expect(await readFile(subagentFile, "utf-8")).toBe("subagent modified");

    // Revert child turn
    const cUndo = await performTurnUndo({ workspaceRoot: testDir });
    expect(cUndo?.turnId).toBe("child-turn");
    expect(await readFile(subagentFile, "utf-8")).toBe("subagent initial");
  });

  // 11. Workspace boundary enforcement
  it("11. refuses to restore files outside authorized workspace root", async () => {
    const outsideFile = join(otherDir, "outside.txt");
    await writeFile(outsideFile, "secret outside content", "utf-8");

    // Manually register a turn with an escaping path
    const turn = startTurnSnapshot({ id: "turn-escape", workspaceRoot: testDir });
    turn.entries.set(outsideFile, {
      path: outsideFile,
      action: "modify",
      preTurnContent: "malicious rewrite",
      timestamp: Date.now(),
      tool: "edit_file",
    });
    commitTurnSnapshot("turn-escape");

    await expect(performTurnUndo({ workspaceRoot: testDir })).rejects.toThrow(
      /Security boundary violation.*outside authorized workspace root/,
    );
  });

  // 12. Snapshot corruption or missing-file handling
  it("12. handles corrupted snapshot metadata gracefully", async () => {
    const turn = startTurnSnapshot({ id: "turn-corrupt", workspaceRoot: testDir });
    // Corrupt entry with empty path
    turn.entries.set("", {
      path: "",
      action: "modify",
      preTurnContent: "corrupt",
      timestamp: Date.now(),
      tool: "edit_file",
    });
    commitTurnSnapshot("turn-corrupt");

    await expect(performTurnUndo({ workspaceRoot: testDir })).rejects.toThrow(
      /Snapshot corruption: invalid path/,
    );
  });

  // 13. Atomic restoration failure and rollback
  it("13. rolls back already-restored files if a subsequent file restore fails", async () => {
    const file1 = join(testDir, "file1.txt");
    const readOnlyDir = join(testDir, "locked-sub");
    const fileInLockedDir = join(readOnlyDir, "file2.txt");

    await writeFile(file1, "file1 original", "utf-8");

    // Start turn
    const turn = startTurnSnapshot({ id: "turn-atomic-fail", workspaceRoot: testDir });

    // File 1 modified
    await pushUndo(file1, "edit_file");
    await writeFile(file1, "file1 modified", "utf-8");

    // File 2 entry points to an impossible path that will fail restoration
    turn.entries.set(fileInLockedDir, {
      path: fileInLockedDir,
      action: "modify",
      preTurnContent: "file2 content",
      timestamp: Date.now(),
      tool: "edit_file",
    });

    commitTurnSnapshot("turn-atomic-fail");

    // Perform turn undo: restoration will hit error on file2 (directory does not exist)
    await expect(performTurnUndo({ workspaceRoot: testDir })).rejects.toThrow(
      /Atomic turn undo failed/,
    );

    // Verify atomic rollback: file1 must be rolled back to its post-turn state ("file1 modified")
    expect(await readFile(file1, "utf-8")).toBe("file1 modified");
  });

  // 14. Backward compatibility with existing /undo behavior
  it("14. maintains full backward compatibility with single-file /undo and /undo turn command", async () => {
    const fileA = join(testDir, "compatA.txt");
    const fileB = join(testDir, "compatB.txt");

    await writeFile(fileA, "A-init", "utf-8");
    await writeFile(fileB, "B-init", "utf-8");

    // Single-file legacy performUndo
    await pushUndo(fileA, "write_file");
    await writeFile(fileA, "A-modified", "utf-8");

    expect(hasUndo()).toBe(true);
    const singleUndo = await performUndo();
    expect(singleUndo?.path).toBe(fileA);
    expect(await readFile(fileA, "utf-8")).toBe("A-init");

    // Test /undo command execution
    startTurnSnapshot({ id: "turn-cmd", workspaceRoot: process.cwd() });
    await pushUndo(fileB, "edit_file");
    await writeFile(fileB, "B-cmd-mod", "utf-8");
    commitTurnSnapshot("turn-cmd");

    // Test /undo list
    const listRes = await undoCommand.execute("list", {} as any);
    expect(listRes.type).toBe("message");
    if (listRes.type === "message") {
      expect(listRes.text).toContain("Turn Snapshots:");
    }

    // Test /undo turn
    const turnRes = await undoCommand.execute("turn", {} as any);
    expect(turnRes.type).toBe("message");
    if (turnRes.type === "message") {
      expect(turnRes.text).toContain("Successfully reverted turn");
    }
    expect(await readFile(fileB, "utf-8")).toBe("B-init");
  });
});
