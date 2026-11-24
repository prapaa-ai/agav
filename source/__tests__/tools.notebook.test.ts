import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readNotebookTool } from "../tools/notebook.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));

const path = resolve("fixture.ipynb");
const mockRead = vi.mocked(readFile);
const mockWrite = vi.mocked(writeFile);

const notebook = {
  cells: [
    { cell_type: "markdown", source: ["# Notes\n"] },
    {
      cell_type: "code",
      source: ["print(value)\n", "value"],
      outputs: [
        { output_type: "stream", text: ["printed value\n"] },
        { output_type: "execute_result", data: { "text/plain": ["result value"] } },
      ],
    },
    { cell_type: "code", source: ["pass"], outputs: [] },
    { cell_type: "code", source: ["value = 1"] },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
};

beforeEach(() => {
  mockRead.mockReset().mockResolvedValue(JSON.stringify(notebook));
  mockWrite.mockReset();
});

describe("read_notebook", () => {
  it("shows bounded cell metadata only when asked", async () => {
    mockRead.mockResolvedValueOnce(JSON.stringify({
      cells: [{ cell_type: "code", source: ["x = 1"], metadata: { tags: ["keep"], nbformat: 4 } }],
      metadata: { kernelspec: { name: "python3" } }, nbformat: 4, nbformat_minor: 5,
    }));
    const plain = await readNotebookTool.execute({ path });
    expect(plain.output).not.toContain("Metadata:");
    const withMeta = await readNotebookTool.execute({ path, include_metadata: true });
    expect(withMeta.output).toContain('"tags":["keep"]');
    expect(withMeta.output).not.toContain("kernelspec");
  });

  it("includes stream and plain-text output by default and with true", async () => {
    const result = await readNotebookTool.execute({ path });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("  Output:");
    expect(result.output).not.toContain("(Showing cells");
    expect(result.output).toContain("printed value");
    expect(result.output).toContain("result value");
    expect(await readNotebookTool.execute({ path, include_outputs: true })).toEqual(result);
  });

  it("omits cached outputs while preserving source, original indices, and the file", async () => {
    const result = await readNotebookTool.execute({ path, include_outputs: false });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("--- Cell 1 [markdown] ---\n# Notes");
    expect(result.output).toContain("--- Cell 2 [code] ---\nprint(value)\nvalue");
    expect(result.output).toContain("--- Cell 3 [code] ---\npass");
    expect(result.output).toContain("--- Cell 4 [code] ---\nvalue = 1");
    expect(result.output).not.toMatch(/Output:|printed value|result value/);
    expect(mockRead).toHaveBeenCalledExactlyOnceWith(path, "utf-8");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it.each(["false", 0, null])("rejects a non-boolean value: %s", async (value) => {
    const result = await readNotebookTool.execute({ path, include_outputs: value });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("include_outputs must be a boolean");
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("retains empty-notebook and invalid-file behavior with outputs disabled", async () => {
    mockRead.mockResolvedValueOnce(JSON.stringify({ ...notebook, cells: [] }));
    expect(await readNotebookTool.execute({ path, include_outputs: false })).toEqual({
      output: "",
      isError: false,
    });
    mockRead.mockResolvedValueOnce("{broken");
    const invalid = await readNotebookTool.execute({ path, include_outputs: false });
    expect(invalid.isError).toBe(true);
    expect(invalid.output).toContain("Failed to read notebook:");
  });
});

describe("read_notebook cell range", () => {
  it.each([
    [{ start_cell: 2, end_cell: 3 }, [2, 3]],
    [{ start_cell: 3 }, [3, 4]],
    [{ end_cell: 2 }, [1, 2]],
    [{ start_cell: 2, end_cell: 99 }, [2, 3, 4]],
  ] as const)("selects original cell numbers for %j", async (bounds, numbers) => {
    const result = await readNotebookTool.execute({ path, ...bounds });
    expect(result.isError).toBe(false);
    expect([...result.output.matchAll(/^--- Cell (\d+) /gm)].map((m) => Number(m[1]))).toEqual(numbers);
    expect(result.output.includes("printed value")).toBe(numbers.some((n) => n === 2));
    expect(result.output).toMatch(new RegExp(`\\(Showing cells ${numbers[0]}-${numbers.at(-1)} of 4\\.\\)$`));
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("composes with source-only mode", async () => {
    const result = await readNotebookTool.execute({ path, start_cell: 2, end_cell: 2, include_outputs: false });
    expect(result.output).toContain("--- Cell 2 [code] ---\nprint(value)\nvalue");
    expect(result.output).not.toMatch(/Cell [134]|Output:/);
  });

  it.each([
    { start_cell: 0 }, { start_cell: "1" }, { start_cell: 1.5 },
    { end_cell: -1 }, { end_cell: null }, { end_cell: Number.MAX_SAFE_INTEGER + 1 },
    { start_cell: 3, end_cell: 2 },
  ])("rejects invalid bounds %j before opening the notebook", async (bounds) => {
    expect((await readNotebookTool.execute({ path, ...bounds })).isError).toBe(true);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("reports a start beyond the notebook and explicit ranges on empty notebooks", async () => {
    const beyond = await readNotebookTool.execute({ path, start_cell: 5 });
    expect(beyond.isError).toBe(true);
    expect(beyond.output).toMatch(/5.*4/);
    mockRead.mockResolvedValueOnce(JSON.stringify({ ...notebook, cells: [] }));
    expect((await readNotebookTool.execute({ path, end_cell: 2 })).output).toMatch(/no cells/i);
  });
});
