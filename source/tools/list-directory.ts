import { readdir, stat } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

export const listDirectoryTool: ToolDefinition = {
  schema: {
    name: "list_directory",
    description:
      "List contents of a directory with file types and sizes. " +
      "Shows files and subdirectories at the given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list (default: current directory)",
        },
      },
      required: [],
    },
  },

  async execute(input): Promise<ToolResult> {
    const dirPath = resolve(String(input.path ?? "."));

    try {
      const entries = await readdir(dirPath);
      const lines: string[] = [];

      for (const entry of entries.sort()) {
        if (entry.startsWith(".")) continue;
        try {
          const fullPath = join(dirPath, entry);
          const info = await stat(fullPath);
          if (info.isDirectory()) {
            lines.push(`${entry}/`);
          } else {
            const size = formatSize(info.size);
            lines.push(`${entry}  ${size}`);
          }
        } catch {
          lines.push(entry);
        }
      }

      if (lines.length === 0) {
        return { output: "Directory is empty.", isError: false };
      }

      return { output: lines.join("\n"), isError: false };
    } catch (err) {
      return {
        output: `Failed to list ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

/** Format byte counts into compact terminal-friendly units for directory listings. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
