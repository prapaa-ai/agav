import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startTurnSnapshot,
  commitTurnSnapshot,
  pushUndo,
  performTurnUndo,
  hasTurnUndo,
  performUndo,
  hasUndo,
} from "../utils/undo.js";

describe("Turn-Based Undo and Atomic Rollback", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `agav-undo-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      // Best-effort cleanup
    } catch {}
  });

  it("reverts all modified files in a turn atomically", async () => {
    const fileA = join(testDir, "a.txt");
    const fileB = join(testDir, "b.txt");

    await writeFile(fileA, "original a", "utf-8");
    await writeFile(fileB, "original b", "utf-8");

    // Begin assistant turn
    startTurnSnapshot("turn-test-1");

    // Tool 1 modifies fileA
    await pushUndo(fileA, "write_file");
    await writeFile(fileA, "modified a", "utf-8");

    // Tool 2 modifies fileB
    await pushUndo(fileB, "write_file");
    await writeFile(fileB, "modified b", "utf-8");

    commitTurnSnapshot();

    expect(hasTurnUndo()).toBe(true);
    expect(await readFile(fileA, "utf-8")).toBe("modified a");
    expect(await readFile(fileB, "utf-8")).toBe("modified b");

    // Rollback turn
    const result = await performTurnUndo();
    expect(result).not.toBeNull();
    expect(result?.revertedCount).toBe(2);

    // Verify both files are restored
    expect(await readFile(fileA, "utf-8")).toBe("original a");
    expect(await readFile(fileB, "utf-8")).toBe("original b");
  });

  it("deletes newly created files when rolling back a turn", async () => {
    const newFile = join(testDir, "new.txt");

    startTurnSnapshot("turn-test-2");
    await pushUndo(newFile, "write_file");
    await writeFile(newFile, "new content", "utf-8");
    commitTurnSnapshot();

    expect(await readFile(newFile, "utf-8")).toBe("new content");

    const result = await performTurnUndo();
    expect(result?.revertedCount).toBe(1);

    // File should be deleted
    let exists = true;
    try {
      await readFile(newFile, "utf-8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("maintains backward compatibility with single-file performUndo", async () => {
    const fileC = join(testDir, "c.txt");
    await writeFile(fileC, "initial", "utf-8");

    await pushUndo(fileC, "write_file");
    await writeFile(fileC, "updated", "utf-8");

    expect(hasUndo()).toBe(true);
    const undoRes = await performUndo();
    expect(undoRes?.path).toBe(fileC);
    expect(await readFile(fileC, "utf-8")).toBe("initial");
  });
});
