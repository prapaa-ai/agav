import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";
import { readFileContext } from "../utils/file-context.js";

export const fileReadTool: ToolDefinition = {
  schema: {
    name: "read_file",
    description:
      "Read a file. Text files support inclusive line ranges; PDF and Office documents support inclusive page ranges; images and document pages return compressed visual previews.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to read (absolute or relative to cwd)",
        },
        start_line: { type: "number", description: "First text line to read (1-based, inclusive)" },
        end_line: { type: "number", description: "Last text line to read (1-based, inclusive)" },
        start_page: { type: "number", description: "First document page to read (1-based, inclusive)" },
        end_page: { type: "number", description: "Last document page to read (1-based, inclusive; at most 10 pages are returned)" },
      },
      required: ["path"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const filePath = resolve(String(input.path));

    try {
      const result = await readFileContext(filePath, {
        startLine: input.start_line === undefined ? undefined : Number(input.start_line),
        endLine: input.end_line === undefined ? undefined : Number(input.end_line),
        startPage: input.start_page === undefined ? undefined : Number(input.start_page),
        endPage: input.end_page === undefined ? undefined : Number(input.end_page),
      });
      return { output: result.output, contentBlocks: result.contentBlocks, isError: false };
    } catch (err) {
      return {
        output: `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
