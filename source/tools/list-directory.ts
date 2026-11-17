import { readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

export const listDirectoryTool: ToolDefinition = {
  schema: {
    name: "list_directory",
    description:
      "List contents of a directory with file types and sizes. " +
      "Optionally show only files or only directories. Names starting with a dot are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list (default: current directory)",
        },
        type: {
          type: "string",
          enum: ["all", "files", "directories"],
          description: "Entry type to include (default: all)",
        },
      },
      required: [],
    },
  },

  async execute(input): Promise<ToolResult> {
    const type = input.type;
    if (type !== undefined && type !== "all" && type !== "files" && type !== "directories") {
      return { output: "type must be all, files, or directories", isError: true };
    }
    const filter = type === "files" || type === "directories" ? type : undefined;
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
            if (filter !== "files") lines.push(`${entry}/`);
          } else if (!filter || (filter === "files" && info.isFile())) {
            const size = formatSize(info.size);
            lines.push(`${entry}  ${size}`);
          }
        } catch {
          if (!filter) lines.push(entry);
        }
      }

      if (lines.length === 0) {
        return { output: filter ? `No ${filter} found.` : "Directory is empty.", isError: false };
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
