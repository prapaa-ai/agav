import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "../utils/tool-output.js";
import type { ToolDefinition, ToolResult } from "./types.js";

function isCellBound(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const MAX_CELL_METADATA_BYTES = 2_000;

function boundedCellMetadata(metadata: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  let remaining = MAX_CELL_METADATA_BYTES;
  function append(text: string): boolean {
    remaining -= Buffer.byteLength(text);
    if (remaining < 0) return false;
    parts.push(text);
    return true;
  }
  function string(value: string): boolean {
    return value.length < remaining && append(JSON.stringify(value));
  }
  function value(input: unknown, depth: number): boolean {
    if (depth > 32) return false;
    if (typeof input === "string") return string(input);
    if (input === null || typeof input === "number" || typeof input === "boolean") {
      return append(JSON.stringify(input));
    }
    if (Array.isArray(input)) {
      if (!append("[")) return false;
      for (let index = 0; index < input.length; index++) {
        if ((index > 0 && !append(",")) || !value(input[index], depth + 1)) return false;
      }
      return append("]");
    }
    if (typeof input !== "object" || !append("{")) return false;
    const object = input as Record<string, unknown>;
    let first = true;
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      if ((!first && !append(",")) || !string(key) || !append(":") || !value(object[key], depth + 1)) return false;
      first = false;
    }
    return append("}");
  }
  return value(metadata, 0) ? parts.join("") : undefined;
}

type NotebookText = string | string[];

interface NotebookCell {
  cell_type: string;
  source: NotebookText;
  metadata?: Record<string, unknown>;
  outputs?: Array<{ text?: NotebookText; output_type?: string; data?: Record<string, NotebookText> }>;
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
      "Read a Jupyter notebook (.ipynb) file. Returns cell types and source, plus outputs by default. Supports an inclusive cell range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the .ipynb file" },
        start_cell: {
          type: "integer",
          minimum: 1,
          description: "First cell to include, numbered from 1 (default: 1)",
        },
        end_cell: {
          type: "integer",
          minimum: 1,
          description: "Last cell to include, numbered from 1 (default: last cell)",
        },
        include_metadata: {
          type: "boolean",
          description: "Show each cell’s metadata when present, up to 2000 bytes per cell (default: false).",
        },
        include_outputs: {
          type: "boolean",
          description: "Include cached execution outputs (default: true).",
        },
      },
      required: ["path"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const includeMetadata = input.include_metadata;
    if (includeMetadata !== undefined && typeof includeMetadata !== "boolean") {
      return { output: "include_metadata must be a boolean", isError: true };
    }
    const includeOutputs = input.include_outputs;
    if (includeOutputs !== undefined && typeof includeOutputs !== "boolean") {
      return { output: "include_outputs must be a boolean", isError: true };
    }
    const { start_cell: start, end_cell: end } = input;
    if (start !== undefined && !isCellBound(start)) {
      return { output: "start_cell must be a positive safe integer", isError: true };
    }
    if (end !== undefined && !isCellBound(end)) {
      return { output: "end_cell must be a positive safe integer", isError: true };
    }
    const hasRange = start !== undefined || end !== undefined;
    const first = start ?? 1;
    if (end !== undefined && end < first) {
      return { output: "end_cell must be greater than or equal to start_cell", isError: true };
    }

    const filePath = resolve(String(input.path));
    try {
      const raw = await readFile(filePath, "utf-8");
      const nb = JSON.parse(raw) as Notebook;
      if (hasRange) {
        if (nb.cells.length === 0) return { output: "Notebook has no cells.", isError: true };
        if (first > nb.cells.length) {
          return { output: `start_cell ${first} is out of range. Notebook has ${nb.cells.length} cells.`, isError: true };
        }
      }
      const last = Math.min(end ?? nb.cells.length, nb.cells.length);
      const parts: string[] = [];
      let bytes = 0;
      let lines = 1;
      const marker = "\n[Notebook output truncated. Request a narrower cell range.]";
      const byteLimit = MAX_TOOL_OUTPUT_BYTES - Buffer.byteLength(marker);

      for (const part of notebookParts(nb, first, last, includeOutputs !== false, includeMetadata === true, hasRange)) {
        bytes += Buffer.byteLength(part);
        if (bytes > byteLimit) return { output: parts.join("") + marker, isError: false };
        for (const char of part) {
          if (char === "\n") lines++;
        }
        if (lines >= MAX_TOOL_OUTPUT_LINES) return { output: parts.join("") + marker, isError: false };
        if (part) parts.push(part);
      }
      return { output: parts.join(""), isError: false };
    } catch (err) {
      return { output: `Failed to read notebook: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

function* notebookText(value: NotebookText): Generator<string> {
  if (typeof value === "string") yield value;
  else yield* value;
}

function* notebookParts(
  nb: Notebook, first: number, last: number, includeOutputs: boolean, includeMetadata: boolean, hasRange: boolean,
): Generator<string> {
  for (let i = first - 1; i < last; i++) {
    const cell = nb.cells[i]!;
    yield `--- Cell ${i + 1} [${cell.cell_type}] ---\n`;
    yield* notebookText(cell.source);
    yield "\n";
    if (includeOutputs && cell.outputs?.length) {
      yield "  Output:\n";
      for (const out of cell.outputs) {
        for (const text of [out.text, out.data?.["text/plain"]]) {
          if (text === undefined) continue;
          yield "  ";
          yield* notebookText(text);
          yield "\n";
        }
      }
    }
    if (includeMetadata && cell.metadata) {
      const metadata = boundedCellMetadata(cell.metadata);
      if (metadata !== "{}") {
        yield "  Metadata:\n";
        yield metadata === undefined
          ? "  [Omitted: metadata exceeds 2000 bytes or nesting limit.]\n"
          : `  ${metadata}\n`;
      }
    }
    if (i + 1 < last || hasRange) yield "\n";
  }
  if (hasRange) yield `(Showing cells ${first}-${last} of ${nb.cells.length}.)`;
}

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
