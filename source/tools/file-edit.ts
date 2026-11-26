import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";
import { computeEditDiffAt, findEditOccurrence } from "../utils/diff.js";
import { pushUndo } from "../utils/undo.js";
import { withFileMutationLock } from "../utils/file-mutation-lock.js";

export const editFileTool: ToolDefinition = {
  schema: {
    name: "edit_file",
    description:
      "Make a surgical edit to a file by replacing a specific string with a new string. " +
      "The old_string must match exactly (including whitespace and indentation). " +
      "Supply occurrence to select one exact match when the text appears more than once. Use read_file first.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to edit (absolute or relative to cwd)",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace (must be unique unless occurrence is supplied)",
        },
        new_string: {
          type: "string",
          description: "The replacement string",
        },
        occurrence: {
          type: "integer",
          minimum: 1,
          description: "One-based index of the exact match to replace",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },

  async execute(input, context): Promise<ToolResult> {
    const filePath = resolve(String(input.path));
    const oldString = String(input.old_string);
    const newString = String(input.new_string);
    const occurrence = input.occurrence;
    if (occurrence !== undefined && (
      typeof occurrence !== "number" || !Number.isSafeInteger(occurrence) || occurrence < 1
    )) {
      return { output: "occurrence must be a positive safe integer", isError: true };
    }

    if (!oldString) {
      return { output: "old_string cannot be empty", isError: true };
    }

    try {
      return await withFileMutationLock(filePath, async (): Promise<ToolResult> => {
        const content = await readFile(filePath, "utf-8");
        const { position, count } = findEditOccurrence(content, oldString, occurrence ?? 1);

        if (count === 0) {
          return {
            output: `String not found in ${filePath}. Make sure old_string matches exactly, including whitespace.`,
            isError: true,
          };
        }

        if (occurrence === undefined && count > 1) {
          return {
            output: `Found ${count} occurrences of old_string in ${filePath}. Provide more surrounding context to make it unique.`,
            isError: true,
          };
        }

        if (position === -1) {
          return { output: `Occurrence ${occurrence} is out of range: found ${count} exact match(es).`, isError: true };
        }

        const diffLines = computeEditDiffAt(content, oldString, newString, position);
        const updated = content.slice(0, position) + newString + content.slice(position + oldString.length);
        await pushUndo(filePath, "edit_file");
        await writeFile(filePath, updated, "utf-8");

        return {
          output: filePath,
          isError: false,
          diffLines,
        };
      }, context?.signal);
    } catch (err) {
      return {
        output: `Failed to edit ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
