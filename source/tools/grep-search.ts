import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, relative, extname, basename } from "node:path";
import { platform } from "node:os";
import type { ToolDefinition, ToolResult } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".next", ".venv", "__pycache__", "coverage"]);
const MAX_FILE_SIZE = 1_048_576; // 1 MB — skip files larger than this
const MAX_RESULTS = 100;

/** Convert a simple glob pattern like "*.ts" to a RegExp. */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Check whether a buffer looks like a binary file (contains null bytes early on). */
function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 512);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Pure Node.js recursive grep implementation for platforms without grep. */
async function nodeGrep(
  searchPath: string,
  pattern: RegExp,
  include: RegExp | undefined,
  filesOnly = false,
): Promise<string[]> {
  const results: string[] = [];
  const limit = filesOnly ? MAX_RESULTS + 1 : MAX_RESULTS;

  async function walkDir(dir: string): Promise<void> {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (filesOnly) throw error;
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walkDir(fullPath);
        }
      } else if (entry.isFile()) {
        if (include && !include.test(entry.name)) continue;
        try {
          const info = await stat(fullPath);
          if (info.size > MAX_FILE_SIZE) continue;
          const buf = await readFile(fullPath);
          if (isBinary(buf)) continue;
          const content = buf.toString("utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= limit) return;
            if (pattern.test(lines[i]!)) {
              results.push(filesOnly ? fullPath : `${fullPath}:${i + 1}:${lines[i]}`);
              if (filesOnly) break;
            }
          }
        } catch (error) {
          if (filesOnly) throw error;
          // Skip unreadable files
        }
      }
    }
  }

  // If searchPath is a file, search just that file
  try {
    const info = await stat(searchPath);
    if (info.isFile()) {
      if (!include || include.test(basename(searchPath))) {
        const buf = await readFile(searchPath);
        if (!isBinary(buf)) {
          const content = buf.toString("utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= limit) break;
            if (pattern.test(lines[i]!)) {
              results.push(filesOnly ? searchPath : `${searchPath}:${i + 1}:${lines[i]}`);
              if (filesOnly) break;
            }
          }
        }
      }
      return results;
    }
  } catch (error) {
    if (filesOnly) throw error;
    return results;
  }

  await walkDir(searchPath);
  return results;
}

/** Run native grep and return output. Rejects if grep is not found. */
async function nativeGrep(
  pattern: string,
  searchPath: string,
  include: string | undefined,
  filesOnly = false,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  // grep can exclude its explicit root too; searching "." bypasses only that
  // root's name, while still excluding generated directories below it.
  const searchFromRoot = SKIP_DIRS.has(basename(searchPath)) &&
    await stat(searchPath).then((info) => info.isDirectory(), () => false);
  const args = filesOnly ? ["-rl", "-I", "--color=never", "-E"] : ["-rn", "-H", "--color=never", "-E"];
  if (include) {
    args.push("--include", include);
  }
  args.push(
    ...Array.from(SKIP_DIRS, (dir) => `--exclude-dir=${dir}`),
    "-e", pattern, "--",
    searchFromRoot ? "." : searchPath,
  );

  return new Promise((resolve, reject) => {
    execFile("grep", args, { maxBuffer: 200_000, timeout: 15_000, cwd: searchFromRoot ? searchPath : undefined }, (error, stdout, stderr) => {
      if (searchFromRoot) {
        stdout = stdout.replace(/(^|\n)(Binary file )?\.\//g, (_match, boundary, prefix = "") => `${boundary}${prefix}${searchPath}/`);
      }
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(error);
      } else {
        resolve({ stdout, stderr: stderr || (filesOnly ? error?.message : "") || "", code: error ? (error as any).code ?? null : 0 });
      }
    });
  });
}

export const grepSearchTool: ToolDefinition = {
  schema: {
    name: "grep_search",
    description:
      "Search for a pattern in files using grep. Returns matching lines with file paths and line numbers. " +
      "Supports regex patterns. Searches recursively from the given directory. Use files_only for matching paths without content.",
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
        files_only: {
          type: "boolean",
          description: "Return each matching text file path once instead of matching lines (default: false).",
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
    if (input.files_only !== undefined && typeof input.files_only !== "boolean") {
      return { output: "Invalid files_only: expected a boolean.", isError: true };
    }
    const filesOnly = input.files_only === true;
    const pattern = String(input.pattern);
    const searchPath = resolve(String(input.path ?? "."));
    const include = input.include ? String(input.include) : undefined;

    // On Windows, always use the Node.js fallback since grep is not available.
    // On Unix, try native grep first for speed, fall back to Node.js if not found.
    if (platform() !== "win32") {
      try {
        const result = await nativeGrep(pattern, searchPath, include, filesOnly);
        if (filesOnly && result.code !== 0 && result.code !== 1) {
          return { output: result.stdout.trimEnd() + "\nSearch incomplete: " + (result.stderr || "grep failed"), isError: true };
        }
        if (result.stdout) {
          const lines = result.stdout.split("\n").filter(Boolean);
          const truncated = lines.length > MAX_RESULTS
            ? lines.slice(0, MAX_RESULTS).join("\n") + (filesOnly ? "\n... results truncated at 100 files" : `\n... ${lines.length - MAX_RESULTS} more matches`)
            : result.stdout.trimEnd();
          return { output: truncated, isError: false };
        }
        if (result.code === 1) {
          return { output: "No matches found.", isError: false };
        }
        return { output: result.stderr || "grep failed", isError: true };
      } catch {
        // grep not found — fall through to Node.js implementation
      }
    }

    // Node.js fallback (always used on Windows)
    try {
      const regex = new RegExp(pattern);
      const includeRegex = include ? globToRegex(include) : undefined;
      const results = await nodeGrep(searchPath, regex, includeRegex, filesOnly);
      if (results.length === 0) {
        return { output: "No matches found.", isError: false };
      }
      const output = filesOnly
        ? results.slice(0, MAX_RESULTS).join("\n") + (results.length > MAX_RESULTS ? "\n... results truncated at 100 files" : "")
        : results.length >= MAX_RESULTS
        ? results.join("\n") + "\n... results truncated at 100 matches"
        : results.join("\n");
      return { output, isError: false };
    } catch (err) {
      return { output: `Search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
