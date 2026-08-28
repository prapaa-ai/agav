import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";
import { computeEditDiff } from "../utils/diff.js";
import { pushUndo } from "../utils/undo.js";

export const editFileTool: ToolDefinition = {
  schema: {
    name: "edit_file",
    description:
      "Make a surgical edit to a file by replacing a specific string with a new string. " +
      "The old_string must match exactly (including whitespace and indentation). " +
      "Only the first occurrence is replaced. Use read_file first to see the current content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to edit (absolute or relative to cwd)",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace (must be unique in the file)",
        },
        new_string: {
          type: "string",
          description: "The replacement string",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const filePath = resolve(String(input.path));
    const oldString = String(input.old_string);
    const newString = String(input.new_string);

    if (!oldString) {
      return { output: "old_string cannot be empty", isError: true };
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return {
          output: `String not found in ${filePath}. Make sure old_string matches exactly, including whitespace.`,
          isError: true,
        };
      }

      if (occurrences > 1) {
        return {
          output: `Found ${occurrences} occurrences of old_string in ${filePath}. Provide more surrounding context to make it unique.`,
          isError: true,
        };
      }

      const diffLines = computeEditDiff(content, oldString, newString);
      const updated = content.replace(oldString, newString);
      await pushUndo(filePath, "edit_file");
      await writeFile(filePath, updated, "utf-8");

      return {
        output: filePath,
        isError: false,
        diffLines,
      };
    } catch (err) {
      return {
        output: `Failed to edit ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
