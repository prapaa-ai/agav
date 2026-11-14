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
