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
  it("includes stream and plain-text output by default and with true", async () => {
    const result = await readNotebookTool.execute({ path });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("  Output:");
    expect(result.output).not.toContain("(Showing cells");
    expect(result.output).toContain("printed value");
    expect(result.output).toContain("result value");
    expect(await readNotebookTool.execute({ path, include_outputs: true })).toEqual(result);
  });

  it("reads notebook source and cached output stored as strings", async () => {
    mockRead.mockResolvedValueOnce(JSON.stringify({
      ...notebook,
      cells: [
        { ...notebook.cells[0], source: "# Notes\nSecond line" },
        {
          ...notebook.cells[1],
          outputs: [
            { output_type: "stream", name: "stdout", text: "first\nsecond\n" },
            { output_type: "execute_result", execution_count: 1, metadata: {}, data: { "text/plain": "result" } },
          ],
        },
      ],
    }));

    const result = await readNotebookTool.execute({ path });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("--- Cell 1 [markdown] ---\n# Notes\nSecond line");
    expect(result.output).toContain("--- Cell 2 [code] ---\nprint(value)\nvalue");
    expect(result.output).toContain("  Output:\n  first\nsecond\n\n  result");
    expect(mockWrite).not.toHaveBeenCalled();
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

describe("read_notebook execution count", () => {
  it("shows execution count for code cells when include_execution_count is true", async () => {
    const notebookWithCount = {
      ...notebook,
      cells: [
        notebook.cells[0],
        {
          ...notebook.cells[1],
          execution_count: 7,
        },
        { cell_type: "code", source: ["pass"], execution_count: null },
        { cell_type: "code", source: ["value = 1"] },
      ],
    };
    mockRead.mockResolvedValueOnce(JSON.stringify(notebookWithCount));

    const result = await readNotebookTool.execute({
      path,
      include_execution_count: true,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("(execution count: 7)");
    expect(result.output).toContain("(execution count: none)");
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it("leaves markdown/raw headers unannotated when include_execution_count is true", async () => {
    const notebookWithCount = {
      ...notebook,
      cells: [
        { cell_type: "markdown", source: ["# Notes\n"], execution_count: 7 },
        {
          ...notebook.cells[1],
          cell_type: "markdown",
          execution_count: 7,
        },
        { cell_type: "raw", source: ["raw content\n"], execution_count: 7 },
      ],
    };
    mockRead.mockResolvedValueOnce(JSON.stringify(notebookWithCount));

    const result = await readNotebookTool.execute({
      path,
      include_execution_count: true,
    });
    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("(execution count:)");
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it("composes with include_outputs: false", async () => {
    const notebookWithCount = {
      ...notebook,
      cells: [
        notebook.cells[0],
        {
          ...notebook.cells[1],
          execution_count: 7,
        },
        { cell_type: "code", source: ["pass"], execution_count: null },
        { cell_type: "code", source: ["value = 1"] },
      ],
    };
    mockRead.mockResolvedValueOnce(JSON.stringify(notebookWithCount));

    const result = await readNotebookTool.execute({
      path,
      include_execution_count: true,
      include_outputs: false,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("(execution count: 7)");
    expect(result.output).not.toContain("  Output:");
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it("rejects non-boolean include_execution_count before readFile", async () => {
    const nonBooleanValues = ["false", 0, null];
    for (const value of nonBooleanValues) {
      const result = await readNotebookTool.execute({ path, include_execution_count: value });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("include_execution_count must be a boolean");
    }
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("default call output is unchanged without include_execution_count", async () => {
    mockRead.mockResolvedValueOnce(JSON.stringify(notebook));
    const result = await readNotebookTool.execute({ path });
    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("(execution count:");
    expect(mockRead).toHaveBeenCalledTimes(1);
  });
});

describe("read_notebook cell type filter", () => {
  const mixedNotebook = {
    ...notebook,
    cells: [
      notebook.cells[0],
      { cell_type: "raw", source: ["Export note\n", "Leave as written."] },
      notebook.cells[1],
      { cell_type: "raw", source: "Outside the requested range" },
    ],
  };

  it("reads raw cells within an inclusive range using their original cell numbers", async () => {
    mockRead.mockResolvedValueOnce(JSON.stringify(mixedNotebook));

    expect(await readNotebookTool.execute({ path, cell_type: "raw", start_cell: 1, end_cell: 2 })).toEqual({
      output: "--- Cell 2 [raw] ---\nExport note\nLeave as written.\n\n(Showing cells 1-2 of 4.)",
      isError: false,
    });
    expect(readNotebookTool.schema.inputSchema).toMatchObject({
      properties: { cell_type: { enum: expect.arrayContaining(["raw"]) } },
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("reports when the selected range contains no raw cells", async () => {
    mockRead.mockResolvedValueOnce(JSON.stringify(mixedNotebook));

    expect(await readNotebookTool.execute({ path, cell_type: "raw", start_cell: 3, end_cell: 3 })).toEqual({
      output: "No raw cells in the selected range.", isError: false,
    });
  });

  it("keeps original cell numbers and composes with range and output selection", async () => {
    const result = await readNotebookTool.execute({ path, cell_type: "code", start_cell: 1, end_cell: 3, include_outputs: false });
    expect(result.isError).toBe(false);
    expect([...result.output.matchAll(/^--- Cell (\d+) /gm)].map((match) => match[1])).toEqual(["2", "3"]);
    expect(result.output).not.toContain("printed value");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("preserves all cells in all mode and describes an empty filtered range", async () => {
    expect(await readNotebookTool.execute({ path, cell_type: "all" })).toEqual(await readNotebookTool.execute({ path }));
    expect(await readNotebookTool.execute({ path, cell_type: "markdown", start_cell: 2 })).toEqual({
      output: "No markdown cells in the selected range.", isError: false,
    });
  });

  it("rejects unsupported cell types before reading", async () => {
    expect(await readNotebookTool.execute({ path, cell_type: "unknown" })).toMatchObject({ isError: true });
    expect(mockRead).not.toHaveBeenCalled();
  });
});
