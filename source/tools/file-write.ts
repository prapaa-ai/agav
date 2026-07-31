import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";
import { computeDiff } from "../utils/diff.js";
import { pushUndo } from "../utils/undo.js";

export const fileWriteTool: ToolDefinition = {
  schema: {
    name: "write_file",
    description:
      "Write content to a file. Creates the file if it doesn't exist, or overwrites it. Creates parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to write to (absolute or relative to cwd)",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const filePath = resolve(String(input.path));
    const content = String(input.content);

    try {
      let oldContent: string | null = null;
      try {
        oldContent = await readFile(filePath, "utf-8");
      } catch {
        // New file
      }

      await mkdir(dirname(filePath), { recursive: true });
      await pushUndo(filePath, "write_file");
      await writeFile(filePath, content, "utf-8");

      if (oldContent !== null) {
        const diffLines = computeDiff(oldContent, content);
        return {
          output: filePath,
          isError: false,
          diffLines,
        };
      }

      const lineCount = content.split("\n").length;
      return {
        output: `Created ${filePath} (${lineCount} lines)`,
        isError: false,
      };
    } catch (err) {
      return {
        output: `Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
