import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getUndoStack, hasUndo, performUndo, pushUndo } from "../utils/undo.js";

describe("utils/undo", () => {
  beforeEach(async () => {
    while (await performUndo()) {
      // drain shared module state
    }
  });

  afterEach(async () => {
    while (await performUndo()) {
      // drain shared module state
    }
  });

  it("captures file contents and restores them on undo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-undo-"));
    const file = join(dir, "note.txt");
    await writeFile(file, "before", "utf8");

    await pushUndo(file, "file-write");
    await writeFile(file, "after", "utf8");

    expect(hasUndo()).toBe(true);
    expect(getUndoStack()).toHaveLength(1);

    const restored = await performUndo();

    expect(restored?.path).toBe(file);
    expect(restored?.tool).toBe("file-write");
    await expect(readFile(file, "utf8")).resolves.toBe("before");
    expect(hasUndo()).toBe(false);
  });

  it("records new file creation and deletes on undo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-undo-new-"));
    const file = join(dir, "new-file.txt");

    await pushUndo(file, "write_file");
    await writeFile(file, "created", "utf8");

    expect(hasUndo()).toBe(true);
    expect(getUndoStack()).toHaveLength(1);

    const restored = await performUndo();
    expect(restored?.path).toBe(file);
    expect(restored?.deleted).toBe(true);

    const { access } = await import("node:fs/promises");
    await expect(access(file)).rejects.toThrow();
  });

  it("keeps only the most recent 20 undo entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-undo-cap-"));

    for (let i = 0; i < 21; i++) {
      const file = join(dir, `file-${i}.txt`);
      await writeFile(file, `content-${i}`, "utf8");
      await pushUndo(file, `tool-${i}`);
    }

    const stack = getUndoStack();
    expect(stack).toHaveLength(20);
    expect(stack[0]?.tool).toBe("tool-1");
    expect(stack.at(-1)?.tool).toBe("tool-20");
  });
});
