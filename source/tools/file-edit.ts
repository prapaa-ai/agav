import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";
import { pushUndo } from "../utils/undo.js";
import {
  planAndValidateEdits,
  writeAtomicFile,
  type EditHunk,
} from "../utils/edit-engine.js";

export const editFileTool: ToolDefinition = {
  schema: {
    name: "edit_file",
    description:
      "Make surgical edit(s) to a file by replacing specific target string(s) with new string(s). " +
      "Supports single edits (old_string, new_string) or atomic multi-block edits (edits array). " +
      "Resilient to line endings, whitespace, and minor variations. Use read_file first to see the current content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to edit (absolute or relative to cwd)",
        },
        old_string: {
          type: "string",
          description: "The string to find and replace (must be unique in the file). Required if edits is not provided.",
        },
        new_string: {
          type: "string",
          description: "The replacement string. Required if edits is not provided.",
        },
        edits: {
          type: "array",
          description: "Optional list of non-overlapping edits to apply atomically. Each item has old_string (or oldText) and new_string (or newText).",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "Text to replace" },
              new_string: { type: "string", description: "Replacement text" },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path"],
    },
  },

  async execute(input, context): Promise<ToolResult> {
    const cwd = context?.cwd ?? process.cwd();
    const filePath = resolve(cwd, String(input.path));

    let hunks: EditHunk[] = [];

    if (Array.isArray(input.edits) && input.edits.length > 0) {
      hunks = input.edits.map((e: any) => ({
        old_string: String(e.old_string ?? e.oldText ?? ""),
        new_string: String(e.new_string ?? e.newText ?? ""),
      }));
    } else if (typeof input.edits === "string") {
      try {
        const parsed = JSON.parse(input.edits);
        if (Array.isArray(parsed)) {
          hunks = parsed.map((e: any) => ({
            old_string: String(e.old_string ?? e.oldText ?? ""),
            new_string: String(e.new_string ?? e.newText ?? ""),
          }));
        } else if (parsed && typeof parsed === "object") {
          hunks = [{
            old_string: String(parsed.old_string ?? parsed.oldText ?? ""),
            new_string: String(parsed.new_string ?? parsed.newText ?? ""),
          }];
        }
      } catch {}
    }

    if (hunks.length === 0) {
      if (input.old_string === undefined && input.oldText === undefined) {
        return {
          output: "Either old_string and new_string, or edits array must be provided",
          isError: true,
        };
      }
      const oldStr = input.old_string !== undefined ? String(input.old_string) : String(input.oldText ?? "");
      const newStr = input.new_string !== undefined ? String(input.new_string) : String(input.newText ?? "");

      if (!oldStr) {
        return { output: "old_string cannot be empty", isError: true };
      }

      hunks = [{ old_string: oldStr, new_string: newStr }];
    }

    // Check for empty old_string across all hunks
    for (let i = 0; i < hunks.length; i++) {
      if (!hunks[i]!.old_string) {
        const msg = hunks.length === 1
          ? "old_string cannot be empty"
          : `edits[${i}].old_string cannot be empty`;
        return { output: msg, isError: true };
      }
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const editResult = planAndValidateEdits(content, hunks, filePath);

      if (!editResult.success) {
        return {
          output: editResult.message,
          isError: true,
        };
      }

      // Record undo state before modifying disk
      await pushUndo(filePath, "edit_file");

      // Write atomically to preserve disk integrity
      await writeAtomicFile(filePath, editResult.updatedContent);

      return {
        output: filePath,
        isError: false,
        diffLines: editResult.diffLines,
      };
    } catch (err) {
      return {
        output: `Failed to edit ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
