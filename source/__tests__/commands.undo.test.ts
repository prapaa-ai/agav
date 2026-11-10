import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  async function trackedFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agav-undo-command-"));
    const file = join(dir, "note.txt");
    await writeFile(file, "before", "utf8");
    await pushUndo(file, "file-write");
    await writeFile(file, "after", "utf8");
    return file;
  }

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
  });
});
