import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { platform } from "node:os";
import type { ToolDefinition, ToolResult } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".next", ".venv", "__pycache__", "coverage"]);
const MAX_RESULTS = 200;

/** Convert a simple glob pattern like "*.tsx" or "config*" to a RegExp. */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Pure Node.js recursive find implementation for platforms without find. */
async function nodeFind(searchPath: string, pattern: RegExp): Promise<string[]> {
  const results: string[] = [];

  async function walkDir(dir: string): Promise<void> {
    if (results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walkDir(fullPath);
        }
      } else if (entry.isFile()) {
        if (pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walkDir(searchPath);
  return results;
}

/** Run native find and return output. Rejects if find is not found or not Unix find. */
function nativeFind(pattern: string, searchPath: string): Promise<string> {
  const args = [
    searchPath,
    "-name", pattern,
    "-not", "-path", "*/node_modules/*",
    "-not", "-path", "*/.git/*",
    "-not", "-path", "*/build/*",
    "-not", "-path", "*/dist/*",
    "-type", "f",
  ];

  return new Promise((resolve, reject) => {
    execFile("find", args, { maxBuffer: 200_000, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(error);
      } else if (error) {
        // On Windows, `find` exists but is a completely different command
        // (string search, not file search). It will error with unexpected args.
        // Detect this and reject so we fall through to the Node.js impl.
        if (stderr && /parameter format/i.test(stderr)) {
          reject(new Error("Windows find.exe is not Unix find"));
        }
        resolve(stdout || "");
      } else {
        resolve(stdout || "");
      }
    });
  });
}

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

    // On Windows, always use the Node.js fallback since Unix find is not available.
    // On Unix, try native find first for speed, fall back to Node.js if not found.
    if (platform() !== "win32") {
      try {
        const stdout = await nativeFind(pattern, searchPath);
        if (stdout) {
          const lines = stdout.split("\n").filter(Boolean);
          const truncated = lines.length > MAX_RESULTS
            ? lines.slice(0, MAX_RESULTS).join("\n") + `\n... ${lines.length - MAX_RESULTS} more files`
            : stdout.trimEnd();
          return { output: truncated, isError: false };
        }
        return { output: "No files found.", isError: false };
      } catch {
        // find not found — fall through to Node.js implementation
      }
    }

    // Node.js fallback (always used on Windows)
    try {
      const regex = globToRegex(pattern);
      const results = await nodeFind(searchPath, regex);
      if (results.length === 0) {
        return { output: "No files found.", isError: false };
      }
      const output = results.length >= MAX_RESULTS
        ? results.join("\n") + `\n... ${results.length - MAX_RESULTS} more files`
        : results.join("\n");
      return { output, isError: false };
    } catch (err) {
      return { output: `Search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
