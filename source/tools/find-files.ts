import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
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
function nativeFind(pattern: string, searchPath: string): Promise<{ stdout: string; stderr: string }> {
  // -path uses glob matching on both BSD and GNU find. Exempt only the
  // literal starting root, even when it is itself an excluded directory.
  const rootPattern = searchPath.replace(/[\[\]*?\\]/g, (char) => "\\" + char);
  const excludedNames = Array.from(SKIP_DIRS).flatMap((dir, i) =>
    i === 0 ? ["-name", dir] : ["-o", "-name", dir]);
  const args = [
    searchPath,
    "(", "-type", "d", "!", "-path", rootPattern,
    "(", ...excludedNames, ")", "-prune", ")",
    "-o", "(", "-type", "f", "-name", pattern, "-print", ")",
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
        resolve({ stdout: stdout || "", stderr: stderr || error.message });
      } else {
        resolve({ stdout: stdout || "", stderr: "" });
      }
    });
  });
}

export const findFilesTool: ToolDefinition = {
  schema: {
    name: "find_files",
    description:
      "Find files matching a glob pattern. Returns absolute paths by default, or paths relative to the search root when relative_paths is true. " +
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
        relative_paths: {
          type: "boolean",
          description: "Show paths relative to the search directory; a matching file used as the root is shown by its name",
        },
      },
      required: ["pattern"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const relativePaths = input.relative_paths;
    if (relativePaths !== undefined && typeof relativePaths !== "boolean") {
      return { output: "relative_paths must be a boolean", isError: true };
    }
    const pattern = String(input.pattern);
    const searchPath = resolve(String(input.path ?? "."));
    const displayPath = (path: string) => relativePaths
      ? relative(searchPath, path) || basename(path)
      : path;

    // On Windows, always use the Node.js fallback since Unix find is not available.
    // On Unix, try native find first for speed, fall back to Node.js if not found.
    if (platform() !== "win32") {
      try {
        const result = await nativeFind(pattern, searchPath);
        if (result.stdout) {
          const lines = result.stdout.split("\n").filter(Boolean);
          const truncated = lines.length > MAX_RESULTS
            ? lines.slice(0, MAX_RESULTS).map(displayPath).join("\n") + `\n... ${lines.length - MAX_RESULTS} more files`
            : relativePaths ? lines.map(displayPath).join("\n") : result.stdout.trimEnd();
          return { output: truncated, isError: false };
        }
        if (result.stderr) {
          return { output: result.stderr, isError: true };
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
      if (relativePaths && results.length === 0 && regex.test(basename(searchPath))) {
        const info = await lstat(searchPath).catch(() => undefined);
        if (info?.isFile()) results.push(searchPath);
      }
      if (results.length === 0) {
        return { output: "No files found.", isError: false };
      }
      const listing = results.map(displayPath).join("\n");
      const output = results.length >= MAX_RESULTS
        ? listing + `\n... ${results.length - MAX_RESULTS} more files`
        : listing;
      return { output, isError: false };
    } catch (err) {
      return { output: `Search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
