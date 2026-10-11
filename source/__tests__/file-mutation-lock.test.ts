import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editFileTool } from "../tools/file-edit.js";
import { fileWriteTool } from "../tools/file-write.js";
import { ToolRegistry } from "../tools/registry.js";
import * as undo from "../utils/undo.js";
import { withFileMutationLock } from "../utils/file-mutation-lock.js";
import { computeDiff } from "../utils/diff.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function registry() {
  const tools = new ToolRegistry();
  tools.register(editFileTool);
  tools.register(fileWriteTool);
  return tools;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agav-mutation-lock-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (await undo.performUndo()) { /* drain shared snapshots before removing files */ }
  await rm(dir, { recursive: true, force: true });
});

describe("file mutation serialization across registries", () => {
  it("preserves independent parallel edits and their undo snapshots", async () => {
    const path = join(dir, "file.txt");
    await writeFile(path, "alpha\nbeta\n");
    const originalPushUndo = undo.pushUndo;
    const entered = gate();
    const resume = gate();
    vi.spyOn(undo, "pushUndo").mockImplementationOnce(async (...args) => {
      entered.release();
      await resume.promise;
      await originalPushUndo(...args);
    });
    const first = registry().execute("edit_file", { path, old_string: "alpha", new_string: "ALPHA" });
    await entered.promise;
    const second = registry().execute("edit_file", { path, old_string: "beta", new_string: "BETA" });
    // Let the second operation reach its snapshot if it is not serialized.
    await new Promise((resolve) => setTimeout(resolve, 30));
    resume.release();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("ALPHA\nBETA\n");
    await undo.performUndo();
    expect(await readFile(path, "utf8")).toBe("ALPHA\nbeta\n");
    await undo.performUndo();
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta\n");
  });

  it("makes an edit queued behind a write read the written content", async () => {
    const path = join(dir, "file.txt");
    await writeFile(path, "before");
    const originalPushUndo = undo.pushUndo;
    const entered = gate();
    const resume = gate();
    vi.spyOn(undo, "pushUndo").mockImplementationOnce(async (...args) => {
      entered.release();
      await resume.promise;
      await originalPushUndo(...args);
    });
    const first = registry().execute("write_file", { path, content: "written" });
    await entered.promise;
    const second = registry().execute("edit_file", { path, old_string: "written", new_string: "edited" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    resume.release();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("edited");
    await undo.performUndo();
    expect(await readFile(path, "utf8")).toBe("written");
    await undo.performUndo();
    expect(await readFile(path, "utf8")).toBe("before");
  });
});


describe("per-path lock", () => {
  it.each(["relative", "file symlink", "parent symlink", "new nested file"])(
    "serializes %s aliases", async (kind) => {
      const targetDir = join(dir, "target");
      await mkdir(targetDir);
      const path = kind === "new nested file"
        ? join(targetDir, "missing", "nested", "file.txt") : join(targetDir, "file.txt");
      if (kind !== "new nested file") await writeFile(path, "original");
      let alias: string;
      if (kind === "relative") {
        alias = relative(process.cwd(), path);
      } else if (kind === "file symlink") {
        alias = join(dir, "alias.txt");
        await symlink(path, alias);
      } else {
        const linkedDir = join(dir, "alias-dir");
        await symlink(targetDir, linkedDir);
        alias = kind === "new nested file"
          ? join(linkedDir, "missing", "nested", "file.txt") : join(linkedDir, "file.txt");
      }
      const entered = gate();
      const resume = gate();
      const order: string[] = [];
      const first = withFileMutationLock(path, async () => {
        order.push("first-start");
        entered.release();
        await resume.promise;
        order.push("first-end");
      });
      await entered.promise;
      const second = withFileMutationLock(alias, async () => { order.push("second"); });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(order).toEqual(["first-start"]);
      resume.release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-start", "first-end", "second"]);
    },
  );

  it("does not block other paths and releases a throwing operation", async () => {
    const path = join(dir, "file.txt");
    const entered = gate();
    const resume = gate();
    const first = withFileMutationLock(path, async () => {
      entered.release();
      await resume.promise;
      throw new Error("failure");
    });
    const failed = expect(first).rejects.toThrow("failure");
    await entered.promise;
    const next = withFileMutationLock(path, async () => "next");
    await expect(withFileMutationLock(join(dir, "other.txt"), async () => "other")).resolves.toBe("other");
    resume.release();
    await failed;
    await expect(next).resolves.toBe("next");
    await expect(withFileMutationLock(path, async () => "reused")).resolves.toBe("reused");
  });

  it("skips cancelled queued tool mutations and allows subsequent work", async () => {
    const path = join(dir, "file.txt");
    await writeFile(path, "before");
    const entered = gate();
    const resume = gate();
    const held = withFileMutationLock(path, async () => {
      entered.release();
      await resume.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const cancelled = registry().execute("write_file", { path, content: "cancelled" }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    resume.release();
    await held;
    expect((await cancelled).isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("before");
    expect(undo.getUndoStack()).toHaveLength(0);
    expect((await registry().execute("write_file", { path, content: "after" })).isError).toBe(false);
  });

  it("does not invoke a pre-cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => undefined);
    await expect(withFileMutationLock(join(dir, "file.txt"), operation, controller.signal)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves creation output, serialized write diffs, and undo snapshots", async () => {
    const path = join(dir, "nested", "file.txt");
    expect(await registry().execute("write_file", { path, content: "first" })).toEqual({
      output: `Created ${path} (1 lines)`, isError: false,
    });
    const originalPushUndo = undo.pushUndo;
    const entered = gate();
    const resume = gate();
    vi.spyOn(undo, "pushUndo").mockImplementationOnce(async (...args) => {
      entered.release();
      await resume.promise;
      await originalPushUndo(...args);
    });
    const first = registry().execute("write_file", { path, content: "second" });
    await entered.promise;
    const second = registry().execute("write_file", { path, content: "third" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    resume.release();
    const results = await Promise.all([first, second]);
    expect(results[1]).toEqual({ output: path, isError: false, diffLines: computeDiff("second", "third") });
    expect(await readFile(path, "utf8")).toBe("third");
    await undo.performUndo();
    expect(await readFile(path, "utf8")).toBe("second");
    await undo.performUndo();
    expect(await readFile(path, "utf8")).toBe("first");
    await undo.performUndo();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("releases failed edits without changing validation outputs", async () => {
    const path = join(dir, "file.txt");
    await writeFile(path, "repeat repeat");
    const tools = registry();
    expect(await tools.execute("edit_file", { path, old_string: "", new_string: "x" })).toEqual({
      output: "old_string cannot be empty", isError: true,
    });
    expect(await tools.execute("edit_file", { path, old_string: "repeat", new_string: "x" })).toEqual({
      output: `Found 2 occurrences of old_string in ${path}. Provide more surrounding context to make it unique.`, isError: true,
    });
    expect(await tools.execute("edit_file", { path, old_string: "missing", new_string: "x" })).toEqual({
      output: `String not found in ${path}. Make sure old_string matches exactly, including whitespace.`, isError: true,
    });
    expect(undo.getUndoStack()).toHaveLength(0);
    expect((await tools.execute("edit_file", { path, old_string: "repeat repeat", new_string: "fixed" })).isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("fixed");
  });
});
