import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../config/config.js";
import { getProjectMemoryPath, loadMemories, renameMemory, saveMemory } from "../config/memory.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-memory-rename-"));
  vi.spyOn(config, "getAgavDir").mockReturnValue(root);
  dir = await getProjectMemoryPath();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const seed = (name: string, content = "body text") =>
  saveMemory({ name, description: `About ${name}`, type: "project", content });

describe("renameMemory", () => {
  it("renames the entry, its file slug, and the index, keeping type, description and content", async () => {
    await seed("old-name");

    const result = await renameMemory("old-name", "new-name");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.memory).toMatchObject({
      name: "new-name",
      description: "About old-name",
      type: "project",
      content: "body text",
    });
    expect((await loadMemories()).map((m) => m.name)).toEqual(["new-name"]);
    expect((await readdir(dir)).sort()).toEqual(["MEMORY.md", "new-name.md"]);
    const index = await readFile(join(dir, "MEMORY.md"), "utf-8");
    expect(index).toContain("[new-name](new-name.md)");
    expect(index).not.toContain("[old-name](");
    const raw = await readFile(join(dir, "new-name.md"), "utf-8");
    expect(raw).toContain("name: new-name");
    expect(raw).toContain("body text");
  });

  it("rewrites the file in place when only the name casing/spacing changes, leaving one record", async () => {
    await seed("old-name");

    const result = await renameMemory("old-name", "old name");

    expect(result.ok).toBe(true);
    expect((await loadMemories()).map((m) => m.name)).toEqual(["old name"]);
    expect((await readdir(dir)).sort()).toEqual(["MEMORY.md", "old-name.md"]);
  });

  it("rejects a destination that collides with another memory by name or by file slug", async () => {
    await seed("first");
    await seed("second-one");

    expect(await renameMemory("first", "second-one")).toEqual({
      ok: false,
      error: `Memory "second-one" already exists. Rename did not change anything.`,
    });
    expect(await renameMemory("first", "second one")).toEqual({
      ok: false,
      error: `Memory "second one" already exists. Rename did not change anything.`,
    });
    expect((await loadMemories()).map((m) => m.name).sort()).toEqual(["first", "second-one"]);
    expect((await readdir(dir)).sort()).toEqual(["MEMORY.md", "first.md", "second-one.md"]);
  });

  it("rejects an unknown source, an empty destination, and a rename to the same name", async () => {
    await seed("only-one");

    expect(await renameMemory("missing", "new-name")).toEqual({
      ok: false,
      error: `Memory "missing" not found.`,
    });
    expect(await renameMemory("only-one", "   ")).toEqual({
      ok: false,
      error: "Usage: /memory rename <old-name> <new-name>",
    });
    expect(await renameMemory("only-one", "only-one")).toEqual({
      ok: false,
      error: `Memory "only-one" is already named "only-one".`,
    });
    expect(await renameMemory("only-one", "---")).toEqual({
      ok: false,
      error: "The new name must contain at least one letter or digit.",
    });
    expect((await loadMemories()).map((m) => m.name)).toEqual(["only-one"]);
  });

  it("never treats a name as a filesystem path", async () => {
    await seed("old-name");

    const result = await renameMemory("old-name", "../../escape");

    expect(result.ok).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(["MEMORY.md", "escape.md"]);
    expect((await readdir(root)).sort()).toEqual(["projects"]);
  });
});
