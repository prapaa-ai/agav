import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

interface NotebookCell {
  cell_type: string;
  source: string[];
  outputs?: Array<{ text?: string[]; output_type?: string; data?: Record<string, string[]> }>;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export const readNotebookTool: ToolDefinition = {
  schema: {
    name: "read_notebook",
    description:
      "Read a Jupyter notebook (.ipynb) file. Returns cells with their type, source, and outputs.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the .ipynb file" },
      },
      required: ["path"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const filePath = resolve(String(input.path));
    try {
      const raw = await readFile(filePath, "utf-8");
      const nb = JSON.parse(raw) as Notebook;
      const lines: string[] = [];

      for (let i = 0; i < nb.cells.length; i++) {
        const cell = nb.cells[i]!;
        const src = cell.source.join("");
        lines.push(`--- Cell ${i + 1} [${cell.cell_type}] ---`);
        lines.push(src);

        if (cell.outputs && cell.outputs.length > 0) {
          lines.push("  Output:");
          for (const out of cell.outputs) {
            if (out.text) lines.push("  " + out.text.join(""));
            if (out.data?.["text/plain"]) lines.push("  " + out.data["text/plain"].join(""));
          }
        }
        lines.push("");
      }

      return { output: lines.join("\n"), isError: false };
    } catch (err) {
      return { output: `Failed to read notebook: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

export const editNotebookTool: ToolDefinition = {
  schema: {
    name: "edit_notebook",
    description:
      "Edit a cell in a Jupyter notebook. Specify cell index (1-based) and new source content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the .ipynb file" },
        cell: { type: "number", description: "Cell index (1-based)" },
        source: { type: "string", description: "New source content for the cell" },
        cell_type: { type: "string", enum: ["code", "markdown"], description: "Optional: change cell type" },
      },
      required: ["path", "cell", "source"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const filePath = resolve(String(input.path));
    const cellIdx = Number(input.cell) - 1;
    const newSource = String(input.source);

    try {
      const raw = await readFile(filePath, "utf-8");
      const nb = JSON.parse(raw) as Notebook;

      if (cellIdx < 0 || cellIdx >= nb.cells.length) {
        return { output: `Cell index out of range. Notebook has ${nb.cells.length} cells.`, isError: true };
      }

      const cell = nb.cells[cellIdx]!;
      cell.source = newSource.split("\n").map((line, i, arr) =>
        i < arr.length - 1 ? line + "\n" : line
      );

      if (input.cell_type) {
        cell.cell_type = String(input.cell_type);
      }

      // Drop cached outputs after code edits so the notebook never shows results from stale source.
      if (cell.cell_type === "code") {
        cell.outputs = [];
      }

      await writeFile(filePath, JSON.stringify(nb, null, 1), "utf-8");
      return { output: `Updated cell ${cellIdx + 1} in ${filePath}`, isError: false };
    } catch (err) {
      return { output: `Failed to edit notebook: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
