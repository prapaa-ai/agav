import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, rm, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import { boundToolResult, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "../utils/tool-output.js";
import type { ToolResult } from "../tools/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), writeFile: vi.fn(actual.writeFile) };
});

const directories: string[] = [];
function savedPath(output: string): string {
  const match = output.match(/Complete returned text: ("(?:[^"\\]|\\.)*")/);
  expect(match).not.toBeNull();
  const path = JSON.parse(match![1]) as string;
  directories.push(dirname(path));
  return path;
}
function expectBounded(output: string): void {
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  expect(output.split("\n").length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LINES);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("shared tool output boundary", () => {
  it("leaves small results untouched, including content and metadata", async () => {
    const result: ToolResult = { output: "hello", isError: false, contentBlocks: [{ type: "text", text: "hello" }] };
    const spy = vi.spyOn(fs, "mkdtemp");
    expect(await boundToolResult(result)).toBe(result);
    expect(spy).not.toHaveBeenCalled();
  });

  it("preserves head/tail, complete text, errors and private file permissions", async () => {
    const text = "FIRST\n" + "x".repeat(100_000) + "\nFINAL ERROR";
    const result = await boundToolResult({ output: text, isError: true, diffLines: [] });
    expectBounded(result.output);
    expect(result.output).toContain("FIRST");
    expect(result.output).toContain("FINAL ERROR");
    expect(result.output).toContain("middle omitted");
    expect(result.isError).toBe(true);
    expect(result.diffLines).toEqual([]);
    const path = savedPath(result.output);
    expect(await readFile(path, "utf8")).toBe(text);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });

  it("bounds thousands of short lines independently of bytes", async () => {
    const text = Array.from({ length: 10_000 }, (_, i) => String(i)).join("\n");
    const result = await boundToolResult({ output: text, isError: false });
    expectBounded(result.output);
    expect(result.output.startsWith("0\n")).toBe(true);
    expect(result.output).toContain("9999");
    expect(await readFile(savedPath(result.output), "utf8")).toBe(text);
  });

  it("does not split multi-byte characters", async () => {
    const text = "😀é中".repeat(15_000);
    const result = await boundToolResult({ output: text, isError: false });
    expectBounded(result.output);
    expect(result.output).not.toContain("�");
    expect(await readFile(savedPath(result.output), "utf8")).toBe(text);
  });

  it("bounds actual nested text collectively without losing images", async () => {
    const image = { type: "image" as const, imageData: "AA==", imageMediaType: "image/png" };
    const text = "a".repeat(25_000);
    const result = await boundToolResult({ output: "preview", isError: false,
      contentBlocks: [{ type: "text", text }, image, { type: "text", text }] });
    expectBounded(result.output);
    expect(result.contentBlocks?.filter((block) => block.type === "image")).toEqual([image]);
    const modelText = result.contentBlocks!.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    expect(result.output).toBe("preview");
    expectBounded(modelText);
    expect(await readFile(savedPath(modelText), "utf8")).toBe(text + "\n" + text);
  });

  it("returns a bounded warning on persistence failure without changing success", async () => {
    vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("disk full"));
    const result = await boundToolResult({ output: "a".repeat(80_000), isError: false });
    expectBounded(result.output);
    expect(result.output).toContain("Could not save");
    expect(result.output).not.toContain("Complete returned text:");
    expect(result.isError).toBe(false);
  });

  it("cleans failed writes before publication", async () => {
    const mkdir = vi.spyOn(fs, "mkdtemp");
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    const result = await boundToolResult({ output: "a".repeat(80_000), isError: true });
    const path = await mkdir.mock.results[0].value;
    await expect(stat(path)).rejects.toThrow();
    expect(result.isError).toBe(true);
  });

  it("uses unique paths for concurrent calls", async () => {
    const results = await Promise.all([1, 2].map((i) => boundToolResult({ output: String(i).repeat(50_000), isError: false })));
    const paths = results.map((result) => savedPath(result.output));
    expect(paths[0]).not.toBe(paths[1]);
    expect(await readFile(paths[0], "utf8")).toBe("1".repeat(50_000));
  });

  it("bounds unknown tool errors", async () => {
    const result = await new ToolRegistry().execute("x".repeat(50_000), {});
    expectBounded(result.output);
    expect(result.isError).toBe(true);
    savedPath(result.output);
  });

  it("bounds registered tools and thrown errors without executing twice", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => { throw new Error("start\n" + "e".repeat(70_000) + "\nend"); });
    registry.register({ schema: { name: "plugin", description: "", inputSchema: {} }, execute });
    const result = await registry.execute("plugin", {});
    expect(execute).toHaveBeenCalledTimes(1);
    expectBounded(result.output);
    expect(result.isError).toBe(true);
    savedPath(result.output);
  });
});
