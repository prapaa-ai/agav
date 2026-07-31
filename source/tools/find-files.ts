import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

export const findFilesTool: ToolDefinition = {
  schema: {
    name: "find_files",
    description:
      "Find files matching a glob pattern. Returns file paths relative to the search directory. " +
      "Useful for discovering project structure or locating specific file types.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "File name or glob pattern (e.g. '*.tsx', 'config*', 'README*')",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: current directory)",
        },
      },
      required: ["pattern"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const pattern = String(input.pattern);
    const searchPath = resolve(String(input.path ?? "."));

    const args = [
      searchPath,
      "-name", pattern,
      "-not", "-path", "*/node_modules/*",
      "-not", "-path", "*/.git/*",
      "-not", "-path", "*/build/*",
      "-not", "-path", "*/dist/*",
      "-type", "f",
    ];

    return new Promise((res) => {
      execFile("find", args, { maxBuffer: 200_000, timeout: 15_000 }, (error, stdout, stderr) => {
        if (stdout) {
          const lines = stdout.split("\n").filter(Boolean);
          const truncated = lines.length > 200 ? lines.slice(0, 200).join("\n") + `\n... ${lines.length - 200} more files` : stdout.trimEnd();
          res({ output: truncated, isError: false });
        } else if (!error) {
          res({ output: "No files found.", isError: false });
        } else {
          res({ output: stderr || error.message, isError: true });
        }
      });
    });
  },
};
