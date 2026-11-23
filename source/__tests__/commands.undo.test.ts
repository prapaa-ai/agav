import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { undoCommand } from "../commands/undo.js";
import type { CommandContext } from "../commands/types.js";
import { getUndoStack, hasUndo, performUndo, pushUndo } from "../utils/undo.js";

/** `/undo` never reads the context, so an empty stub keeps the calls honest about its signature. */
const context = {} as CommandContext;

/** Message text of a command result, narrowed so the assertions read plainly. */
function textOf(result: Awaited<ReturnType<typeof undoCommand.execute>>): string {
  if (result.type !== "message") throw new Error(`expected a message, got ${result.type}`);
  return result.text;
}

describe("commands/undo", () => {
  /** Directories created by these tests, removed after each one. */
  const tempDirs: string[] = [];

  beforeEach(async () => {
    while (await performUndo()) {
      // drain shared module state
    }
  });

  afterEach(async () => {
    try {
      while (await performUndo()) {
        // drain shared module state
      }
    } finally {
      // Drain first: undoing writes inside a deleted directory would fail.
      await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  /** Creates a temporary directory that `afterEach` removes. */
  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function trackedFile(): Promise<string> {
    const dir = await tempDir("agav-undo-command-");
    const file = join(dir, "note.txt");
    await writeFile(file, "before", "utf8");
    await pushUndo(file, "file-write");
    await writeFile(file, "after", "utf8");
    return file;
  }

  /** Three tracked files; list numbers are 1 = newest, 3 = oldest. */
  async function threeTrackedFiles(): Promise<string[]> {
    const dir = await tempDir("agav-undo-command-");
    const files: string[] = [];
    for (let i = 0; i < 3; i++) {
      const file = join(dir, `note-${i}.txt`);
      await writeFile(file, `before-${i}`, "utf8");
      await pushUndo(file, "file-write");
      await writeFile(file, `after-${i}`, "utf8");
      files.push(file);
    }
    return files;
  }

  it("reverts only the selected entry and keeps newer changes", async () => {
    const [first, second, third] = await threeTrackedFiles();

    // Entry 3 is the oldest file; reverting it must leave the two newer ones alone.
    const text = textOf(await undoCommand.execute("3", context));

    expect(text).toContain("Reverted file-write");
    expect(text).toContain(first!);
    await expect(readFile(first!, "utf8")).resolves.toBe("before-0");
    await expect(readFile(second!, "utf8")).resolves.toBe("after-1");
    await expect(readFile(third!, "utf8")).resolves.toBe("after-2");
    expect(getUndoStack()).toHaveLength(2);
    // The survivors renumber from the newest: the former #1 is still #1.
    expect(textOf(await undoCommand.execute("list", context))).toContain("1. file-write");
  });

  it("reverts the newest entry when its list number is given", async () => {
    const [first, second, third] = await threeTrackedFiles();

    // Entry 1 is the newest file.
    const text = textOf(await undoCommand.execute("1", context));

    expect(text).toContain("Reverted file-write");
    expect(text).toContain(third!);
    await expect(readFile(first!, "utf8")).resolves.toBe("after-0");
    await expect(readFile(second!, "utf8")).resolves.toBe("after-1");
    await expect(readFile(third!, "utf8")).resolves.toBe("before-2");
    expect(getUndoStack()).toHaveLength(2);
  });

  it("rejects zero, out-of-range, fractional, negative, and malformed numbers without mutating", async () => {
    const files = await threeTrackedFiles();

    for (const bad of ["0", "4", "1.5", "-1", "2x", "+2"]) {
      const text = textOf(await undoCommand.execute(bad, context));
      expect(text, `args=${bad}`).toContain("Invalid undo entry");
      expect(text, `args=${bad}`).toContain("/undo list");
    }

    expect(getUndoStack()).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      await expect(readFile(files[i]!, "utf8")).resolves.toBe(`after-${i}`);
    }
  });

  it("rejects an argument it does not know instead of reverting", async () => {
    const file = await trackedFile();

    const text = textOf(await undoCommand.execute("lsit", context));

    expect(text).toContain("Unknown argument: lsit");
    expect(text).toContain("/undo list");
    expect(hasUndo()).toBe(true);
    expect(getUndoStack()).toHaveLength(1);
    await expect(readFile(file, "utf8")).resolves.toBe("after");
  });

  it("does not consume the entry for a typo, so the next undo still reverts it", async () => {
    const file = await trackedFile();

    await undoCommand.execute("lsit", context);
    const text = textOf(await undoCommand.execute("", context));

    expect(text).toContain("Reverted file-write");
    await expect(readFile(file, "utf8")).resolves.toBe("before");
  });

  it("lists the stack without reverting", async () => {
    const file = await trackedFile();

    const text = textOf(await undoCommand.execute(" list ", context));

    expect(text).toContain("Undo stack:");
    expect(text).toContain(file);
    expect(hasUndo()).toBe(true);
    await expect(readFile(file, "utf8")).resolves.toBe("after");
  });

  it("still reverts on empty or whitespace-only input", async () => {
    for (const args of ["", "   "]) {
      const file = await trackedFile();

      const text = textOf(await undoCommand.execute(args, context));

      expect(text, `args=${JSON.stringify(args)}`).toContain("Reverted file-write");
      await expect(readFile(file, "utf8")).resolves.toBe("before");
    }
  });

  it("advertises list in its usage", () => {
    expect(undoCommand.usage).toContain("/undo list");
    expect(undoCommand.usage).toContain("/undo <n>");
  });
});
