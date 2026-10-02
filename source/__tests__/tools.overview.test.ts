import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

import { readdir, readFile } from "node:fs/promises";
import { overviewTool } from "../tools/overview.js";

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agav-overview-test-"));
  path = relative(process.cwd(), directory);
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function file(name: string, content = "export function example() {}") {
  const target = join(directory, name);
  const parent = name.split("/").slice(0, -1).join("/");
  if (parent) await mkdir(join(directory, parent), { recursive: true });
  await writeFile(target, content);
}
async function nestedFixture() {
  await file("root.ts", "export function rootSymbol() {}");
  await file("child/child.ts", "export class ChildSymbol {}");
  await file("child/deep/deep.ts", "export interface DeepSymbol {}");
  await file("child/deep/deeper/deeper.ts", "export type DeeperSymbol = string;");
}

describe("overview depth", () => {
  it("reads root files only at depth 0, without traversing children", async () => {
    await nestedFixture();
    const result = await overviewTool.execute({ path, depth: 0 });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("1 files, 1 symbols\n\n./\n  root.ts — rootSymbol()");
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("includes immediate subdirectories at depth 1, not grandchildren", async () => {
    await nestedFixture();
    const result = await overviewTool.execute({ path, depth: 1 });
    expect(result.output).toContain("2 files, 2 symbols");
    expect(result.output).toContain("ChildSymbol (class)");
    expect(result.output).toContain("rootSymbol()");
    expect(result.output).not.toContain("DeepSymbol");
    expect(readdir).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("includes files at the requested boundary and excludes deeper files", async () => {
    await nestedFixture();
    const result = await overviewTool.execute({ path, depth: 2 });
    expect(result.output).toContain("3 files, 3 symbols");
    expect(result.output).toContain("DeepSymbol (interface)");
    expect(result.output).not.toContain("DeeperSymbol");
    expect(readdir).toHaveBeenCalledTimes(3);
  });

  it("preserves unrestricted traversal and symbol formatting when omitted", async () => {
    await nestedFixture();
    await file("child/deep/deeper/four/five/six/seven/far.py", "def far_symbol():\n    pass\n");
    const result = await overviewTool.execute({ path });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("5 files, 5 symbols");
    expect(result.output).toContain("DeeperSymbol (type)");
    expect(result.output).toContain("far.py — far_symbol()");
    expect(result.output).not.toContain("File limit reached");
  });

  it.each([-1, 1.5, NaN, Infinity, -Infinity, "1", null, true, {}, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid depth %s before scanning", async (depth) => {
      const result = await overviewTool.execute({ path, depth });
      expect(result).toEqual({ output: "Depth must be a non-negative safe integer.", isError: true });
      expect(readdir).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it("documents depth semantics and the unchanged omitted-depth behavior", () => {
    const schema = overviewTool.schema.inputSchema as any;
    expect(schema.properties.depth.type).toBe("integer");
    expect(schema.properties.depth.minimum).toBe(0);
    expect(schema.properties.depth.description).toContain("0 reads root files only");
    expect(schema.properties.depth.description).toContain("Omit for unrestricted depth");
  });

  it("preserves excluded directories and unsupported file handling", async () => {
    await file("visible.ts");
    for (const excluded of ["node_modules", ".git", "build", "dist", ".agav-worktrees", "coverage", ".hidden", "__pycache__", ".venv", "target"]) {
      await file(`${excluded}/hidden.ts`, "export function excludedSymbol() {}");
    }
    await file("notes.txt", "export function unsupportedSymbol() {}");
    const result = await overviewTool.execute({ path, depth: 3 });
    expect(result.output).toBe("1 files, 1 symbols\n\n./\n  visible.ts — example()");
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it("handles a root with no source files within the requested depth", async () => {
    await file("child/example.ts");
    expect(await overviewTool.execute({ path, depth: 0 })).toEqual({ output: "No source files found.", isError: false });
    expect((await overviewTool.execute({ path, depth: 1 })).output).toContain("example.ts");
  });

  it("preserves missing directory errors", async () => {
    const missing = join(path, "missing");
    expect(await overviewTool.execute({ path: missing })).toEqual({ output: `Directory not found: ${missing}`, isError: true });
  });

  it("stops recursive traversal before later siblings when a child reaches the cap", async () => {
    await Promise.all(Array.from({ length: 200 }, (_, i) => file(`a-first/file-${String(i).padStart(3, "0")}.ts`)));
    await file("z-later/omitted.ts");
    await file("root.ts");
    const result = await overviewTool.execute({ path });
    expect(result.output).toContain("200 files, 200 symbols");
    expect(result.output).toContain("File limit reached (200)");
    expect(result.output).not.toContain("omitted.ts");
    expect(result.output).not.toContain("root.ts");
    expect(readdir).toHaveBeenCalledTimes(2);
    expect(readdir).not.toHaveBeenCalledWith(join(process.cwd(), path, "z-later"), expect.anything());
    expect(readFile).toHaveBeenCalledTimes(200);
  });

  it.each([199, 200, 201])("reports the cap conservatively for %s source files", async (count) => {
    await Promise.all(Array.from({ length: count }, (_, i) => file(`file-${String(i).padStart(3, "0")}.ts`)));
    const result = await overviewTool.execute({ path, depth: 0 });
    expect(result.isError).toBe(false);
    expect(result.output).toContain(`${Math.min(count, 200)} files, ${Math.min(count, 200)} symbols`);
    expect(readFile).toHaveBeenCalledTimes(Math.min(count, 200));
    expect(result.output.includes("File limit reached (200)")).toBe(count >= 200);
    if (count >= 200) {
      expect(result.output).toContain("may be incomplete");
      expect(result.output).toContain("narrower path or depth");
    }
    expect(result.output).not.toContain("file-200.ts");
  });
});
