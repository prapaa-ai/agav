import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../config/memory.js";

// The store is never touched: loading and every write are mocked, and only the real search runs.
vi.mock("../config/memory.js", async (importActual) => ({
  ...(await importActual<typeof import("../config/memory.js")>()),
  loadMemories: vi.fn(async () => []),
  saveMemory: vi.fn(),
  deleteMemory: vi.fn(),
  deleteAllMemories: vi.fn(),
  getProjectMemoryPath: vi.fn(),
}));

import { memoryCommand } from "../commands/memory.js";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { deleteAllMemories, deleteMemory, loadMemories, saveMemory, searchMemories } from "../config/memory.js";

const memory = (name: string, description: string, content: string, type: MemoryEntry["type"] = "project"): MemoryEntry => ({
  name,
  description,
  type,
  content,
  filePath: `/memories/${name}.md`,
});

const MEMORIES = [
  memory("api-shape", "The API response shape is versioned", "Clients pin v2 of the response."),
  memory("prefer-tabs", "Prefer tabs over spaces", "Use TABS in every source file.", "feedback"),
  memory("release-notes", "Write release notes", `Each release gets notes.\n\n${"x".repeat(200)} the Release Train runs on Fridays ${"y".repeat(200)}`),
];

const run = async (args: string) => {
  const result = await memoryCommand.execute(args, {} as CommandContext);
  if (result.type !== "message") throw new Error(`expected a message, got ${result.type}`);
  return result.text;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadMemories).mockResolvedValue(MEMORIES);
});

describe("searchMemories", () => {
  it("matches name, description and content case-insensitively, each memory once, in loader order", () => {
    expect(searchMemories(MEMORIES, "TABS").map((m) => m.memory.name)).toEqual(["prefer-tabs"]);
    expect(searchMemories(MEMORIES, "api-SHAPE").map((m) => m.memory.name)).toEqual(["api-shape"]);
    // "ver" is in api-shape's description and in both of prefer-tabs' fields ("over", "every")
    expect(searchMemories(MEMORIES, "VER").map((m) => m.memory.name)).toEqual(["api-shape", "prefer-tabs"]);
  });

  it("treats a multiword query as one literal phrase", () => {
    expect(searchMemories(MEMORIES, "release train").map((m) => m.memory.name)).toEqual(["release-notes"]);
    expect(searchMemories(MEMORIES, "train release")).toEqual([]);
    expect(searchMemories(MEMORIES, "v2.")).toEqual([]);
    expect(searchMemories(MEMORIES, "(v2")).toEqual([]);
  });

  it("excerpts the first matching field around the match, on one bounded line", () => {
    const [match] = searchMemories(MEMORIES, "release train");
    expect(match.excerpt).toMatch(/^….*the Release Train runs on Fridays.*…$/);
    expect(match.excerpt).not.toContain("\n");
    expect(match.excerpt.length).toBeLessThanOrEqual("release train".length + 80 + 2);
    expect(searchMemories(MEMORIES, "tabs")[0].excerpt).toBe("prefer-tabs");
  });

  it("matches whitespace literally", () => {
    const wrapped = [memory("deploys", "Deploy notes", "Never deploy on a\nFriday   afternoon.")];
    expect(searchMemories(wrapped, "friday afternoon")).toEqual([]);
    expect(searchMemories(wrapped, "a friday")).toEqual([]);
    expect(searchMemories(wrapped, "friday   afternoon")[0].excerpt).toBe("Never deploy on a Friday afternoon.");
  });

  it("bounds the excerpt however long the query is", () => {
    const long = "word ".repeat(2000).trim();
    const [match] = searchMemories([memory("long", "x", `before ${long} after`)], long);
    expect(match.excerpt.length).toBeLessThanOrEqual(120 + 2);
    expect(match.excerpt).toMatch(/^before word .*…$/);
  });

  it("never cuts a character made of two UTF-16 code units in half", () => {
    const wellFormed = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
    const before = searchMemories([memory("start", "x", `😀${"x".repeat(39)}needle`)], "needle")[0].excerpt;
    expect(before).toBe(`…${"x".repeat(39)}needle`);
    const after = searchMemories([memory("end", "x", `needle${"x".repeat(39)}😀 more`)], "needle")[0].excerpt;
    expect(after).toBe(`needle${"x".repeat(39)}…`);
    // a 119-unit match puts the 120-unit cap between the emoji's two halves
    const capped = searchMemories([memory("cap", "x", `${"x".repeat(119)}😀 tail`)], "x".repeat(119))[0].excerpt;
    expect(capped).toBe(`${"x".repeat(119)}…`);
    expect([before, after, capped].every(wellFormed)).toBe(true);
  });

  it("keeps the excerpt on the match when lower-casing changes the text's length", () => {
    const [match] = searchMemories([memory("turkish", "dotted capitals", `${"İ".repeat(50)}needle`)], "needle");
    expect(match.excerpt).toContain("needle");
  });

  it("matches Greek final sigma either way", () => {
    const greek = [memory("greek", "ΟΣ ΚΑΙ ΟΣ", "λόγος")];
    expect(searchMemories(greek, "ος και")).toHaveLength(1);
    expect(searchMemories([memory("word", "x", "λόγος")], "ΛΌΓΟΣ")).toHaveLength(1);
  });

  it("returns nothing for an empty query", () => {
    expect(searchMemories(MEMORIES, "   ")).toEqual([]);
  });
});

describe("/memory search", () => {
  it("lists each match with its name, type and excerpt", async () => {
    const text = await run("search  Release Train");
    expect(text).toContain('Memories matching "Release Train" (1 of 3):');
    expect(text).toContain("  [project] release-notes\n    …");
    expect(text).toContain("the Release Train runs on Fridays");
  });

  it("finds a phrase typed with extra spaces through the command registry", async () => {
    const context = { isLoading: false, setPickerActive: vi.fn() } as unknown as CommandContext;
    const result = await new CommandRegistry().execute("/memory search   Release    Train", context);
    expect(result).toMatchObject({ type: "message" });
    expect((result as { text: string }).text).toContain('Memories matching "Release Train" (1 of 3):');
  });

  it("tells no matches apart from no saved memories", async () => {
    expect(await run("search nothing-like-this")).toBe('No memories match "nothing-like-this" (searched 3).');
    vi.mocked(loadMemories).mockResolvedValue([]);
    expect(await run("search tabs")).toBe("No memories saved yet, so there is nothing to search.");
  });

  it.each(["search", "search    "])("answers %j with usage guidance without loading memories", async (args) => {
    expect(await run(args)).toMatch(/^Usage: \/memory search <query>/);
    expect(loadMemories).not.toHaveBeenCalled();
  });

  it("never writes to the memory store", async () => {
    await run("search tabs");
    expect(saveMemory).not.toHaveBeenCalled();
    expect(deleteMemory).not.toHaveBeenCalled();
    expect(deleteAllMemories).not.toHaveBeenCalled();
  });

  it("is listed in the usage and argument hint", () => {
    expect(memoryCommand.argumentHint).toContain("search");
    expect(memoryCommand.usage).toContain("/memory search <q>");
  });
});
