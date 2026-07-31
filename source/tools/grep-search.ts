import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

export const grepSearchTool: ToolDefinition = {
  schema: {
    name: "grep_search",
    description:
      "Search for a pattern in files using grep. Returns matching lines with file paths and line numbers. " +
      "Supports regex patterns. Searches recursively from the given directory.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search in (default: current directory)",
        },
        include: {
          type: "string",
          description: "File glob pattern to include (e.g. '*.ts', '*.py')",
        },
      },
      required: ["pattern"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const pattern = String(input.pattern);
    const searchPath = resolve(String(input.path ?? "."));
    const include = input.include ? String(input.include) : undefined;

    const args = ["-rn", "--color=never", "-E"];
    if (include) {
      args.push("--include", include);
    }
    args.push(
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--exclude-dir=build",
      "--exclude-dir=dist",
      pattern,
      searchPath,
    );

    return new Promise((res) => {
      execFile("grep", args, { maxBuffer: 200_000, timeout: 15_000 }, (error, stdout, stderr) => {
        if (stdout) {
          const lines = stdout.split("\n").filter(Boolean);
          const truncated = lines.length > 100 ? lines.slice(0, 100).join("\n") + `\n... ${lines.length - 100} more matches` : stdout.trimEnd();
          res({ output: truncated, isError: false });
        } else if (error && error.code === 1) {
          res({ output: "No matches found.", isError: false });
        } else {
          res({ output: stderr || error?.message || "grep failed", isError: true });
        }
      });
    });
  },
};
