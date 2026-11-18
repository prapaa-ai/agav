import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editFileTool } from "../tools/file-edit.js";
import { pushUndo } from "../utils/undo.js";

vi.mock("../utils/undo.js", () => ({ pushUndo: vi.fn().mockResolvedValue(undefined) }));

const original = "first\n  target\nsecond\n  target\n";
let temp: string;
let path: string;
beforeEach(async () => {
  vi.clearAllMocks();
  temp = await mkdtemp(join(tmpdir(), "agav-file-edit-"));
  path = join(temp, "sample.txt");
  await writeFile(path, original);
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("edit_file occurrence selection", () => {
  it("replaces the selected exact match and reports its line in the diff", async () => {
    const result = await editFileTool.execute({ path, old_string: "  target", new_string: "  fixed", occurrence: 2 });
    expect(result.isError).toBe(false);
    expect(await readFile(path, "utf-8")).toBe("first\n  target\nsecond\n  fixed\n");
    expect(result.diffLines).toEqual(expect.arrayContaining([
      { type: "remove", lineNo: 4, text: "  target" },
      { type: "add", lineNo: 4, text: "  fixed" },
    ]));
    expect(pushUndo).toHaveBeenCalledExactlyOnceWith(path, "edit_file");
  });

  it.each([undefined, 0, -1, 2.5, "2", null, 3, Number.MAX_SAFE_INTEGER + 1])(
    "rejects ambiguous, invalid or out-of-range selection %s without writing",
    async (occurrence) => {
      const result = await editFileTool.execute({ path, old_string: "  target", new_string: "  fixed", occurrence });
      expect(result.isError).toBe(true);
      expect(await readFile(path, "utf-8")).toBe(original);
      expect(pushUndo).not.toHaveBeenCalled();
    },
  );

  it("preserves the unique-match default and handles an empty replacement", async () => {
    const result = await editFileTool.execute({ path, old_string: "second\n", new_string: "" });
    expect(result.isError).toBe(false);
    expect(await readFile(path, "utf-8")).toBe("first\n  target\n  target\n");
  });
});
