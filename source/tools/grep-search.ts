import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, relative, extname, basename } from "node:path";
import { platform } from "node:os";
import type { ToolDefinition, ToolResult } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".next", ".venv", "__pycache__", "coverage"]);
const MAX_FILE_SIZE = 1_048_576; // 1 MB — skip files larger than this
const DEFAULT_MAX_RESULTS = 100;

/** Convert a simple glob pattern like "*.ts" to a RegExp. */
function globToRegex(glob: string, flags = "i"): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, flags);
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
  exclude: RegExp | undefined,
  filesOnly: boolean,
  limit: number,
): Promise<string[]> {
  const matchesFileName = (name: string) =>
    (!include || include.test(name)) && (!exclude || !exclude.test(name));
  const results: string[] = [];

  async function walkDir(dir: string): Promise<void> {
    if (results.length > limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (filesOnly) throw error;
      return;
    }
    for (const entry of entries) {
      if (results.length > limit) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walkDir(fullPath);
        }
      } else if (entry.isFile()) {
        if (!matchesFileName(entry.name)) continue;
        try {
          const info = await stat(fullPath);
          if (info.size > MAX_FILE_SIZE) continue;
          const buf = await readFile(fullPath);
          if (isBinary(buf)) continue;
          const content = buf.toString("utf-8");
          const lines = content.split("\n");
          const lineCount = content === "" ? 0 : content.endsWith("\n") ? lines.length - 1 : lines.length;
          for (let i = 0; i < lineCount; i++) {
            if (results.length > limit) return;
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
      if (matchesFileName(basename(searchPath))) {
        const buf = await readFile(searchPath);
        if (!isBinary(buf)) {
          const content = buf.toString("utf-8");
          const lines = content.split("\n");
          const lineCount = content === "" ? 0 : content.endsWith("\n") ? lines.length - 1 : lines.length;
          for (let i = 0; i < lineCount; i++) {
            if (results.length > limit) break;
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
  exclude: { glob: string; regex: RegExp } | undefined,
  filesOnly = false,
  fixedStrings = false,
  ignoreCase = false,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  // grep can exclude its explicit root too; searching "." bypasses only that
  // root's name, while still excluding generated directories below it.
  const searchFromRoot = SKIP_DIRS.has(basename(searchPath)) &&
    await stat(searchPath).then((info) => info.isDirectory(), () => false);
  const args = filesOnly ? ["-rl", "-I", "--color=never"] : ["-rn", "-H", "--color=never"];
  args.push(fixedStrings ? "-F" : "-E");
  if (ignoreCase) {
    args.push("-i");
  }
  if (include) {
    args.push("--include", include);
  }
  if (exclude) {
    // grep can silently skip explicit missing paths that match --exclude.
    // Keep its existing diagnostic by leaving the filter out for that path.
    const canApplyExclude = !exclude.regex.test(basename(searchPath)) ||
      await stat(searchPath).then(() => true, () => false);
    if (canApplyExclude) args.push(`--exclude=${exclude.glob}`);
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
      "Supports regex patterns by default; pass fixed_strings: true to match exact literal text. " +
      "Searches recursively from the given directory. Use exclude to skip matching file names. Use files_only for matching paths without content. Use ignore_case to match without regard to letter case.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The pattern to search for. Treated as a regex by default; set fixed_strings: true to match it literally.",
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
        exclude: {
          type: "string",
          description: "Case-sensitive basename glob to exclude after include. Supports * and ?; no paths, ranges or escapes.",
        },
        fixed_strings: {
          type: "boolean",
          description: "Match the pattern as a fixed literal string, not a regex (default: false). Useful for text with regex metacharacters such as [ ] ( ) . * + ?. Patterns may not contain newlines in this mode.",
        },
        ignore_case: {
          type: "boolean",
          description: "Match without regard to letter case (default: false). Affects content matching only; include-glob behavior is unchanged.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          description: `Maximum matching lines or file paths to return (default: ${DEFAULT_MAX_RESULTS})`,
        },
      },
      required: ["pattern"],
    },
  },

  async execute(input): Promise<ToolResult> {
    if (input.files_only !== undefined && typeof input.files_only !== "boolean") {
      return { output: "Invalid files_only: expected a boolean.", isError: true };
    }
    if (input.fixed_strings !== undefined && typeof input.fixed_strings !== "boolean") {
      return { output: "Invalid fixed_strings: expected a boolean.", isError: true };
    }
    if (input.ignore_case !== undefined && typeof input.ignore_case !== "boolean") {
      return { output: "Invalid ignore_case: expected a boolean.", isError: true };
    }
    const requestedLimit = input.max_results;
    if (requestedLimit !== undefined && (
      typeof requestedLimit !== "number" || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1
    )) {
      return { output: "max_results must be a positive safe integer", isError: true };
    }
    const limit = requestedLimit ?? DEFAULT_MAX_RESULTS;
    const excludeGlob = input.exclude;
    if (excludeGlob !== undefined &&
        (typeof excludeGlob !== "string" || !excludeGlob || /[\/\\\[\]\0\r\n]/.test(excludeGlob))) {
      return { output: "Invalid exclude: expected a nonempty basename glob with * or ? wildcards (no paths, ranges or escapes).", isError: true };
    }
    const exclude = excludeGlob === undefined ? undefined : { glob: excludeGlob, regex: globToRegex(excludeGlob, "su") };
    const filesOnly = input.files_only === true;
    const fixedStrings = input.fixed_strings === true;
    const ignoreCase = input.ignore_case === true;
    const unit = filesOnly ? (limit === 1 ? "file" : "files") : (limit === 1 ? "match" : "matches");
    const capOrigin = requestedLimit === undefined ? "" : "requested limit of ";
    const capNotice = `\n... results truncated at ${capOrigin}${limit} ${unit}`;
    const pattern = String(input.pattern);
    const searchPath = resolve(String(input.path ?? "."));
    const include = input.include ? String(input.include) : undefined;

    if (fixedStrings && pattern.includes("\n")) {
      return { output: "Invalid fixed_strings pattern: patterns may not contain newlines.", isError: true };
    }

    // On Windows, always use the Node.js fallback since grep is not available.
    // On Unix, try native grep first for speed, fall back to Node.js if not found.
    if (platform() !== "win32") {
      try {
        const result = await nativeGrep(pattern, searchPath, include, exclude, filesOnly, fixedStrings, ignoreCase);
        const incomplete = result.code !== 0 && result.code !== 1;
        const partialLine = requestedLimit !== undefined && incomplete && !result.stdout.endsWith("\n");
        const stdout = partialLine ? result.stdout.slice(0, result.stdout.lastIndexOf("\n") + 1) : result.stdout;
        const lines = stdout.split("\n").filter(Boolean);
        const output = lines.length > limit
          ? lines.slice(0, limit).join("\n") + (filesOnly || requestedLimit !== undefined
            ? capNotice
            : `\n... ${lines.length - limit} more matches`)
          : stdout.trimEnd();
        if ((filesOnly || requestedLimit !== undefined) && incomplete) {
          return { output: output + "\nSearch incomplete: " + (result.stderr || "grep failed"), isError: true };
        }
        if (result.stdout) {
          return { output, isError: false };
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
      const escapedPattern = fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
      const regex = new RegExp(escapedPattern, ignoreCase ? "i" : "");
      const includeRegex = include ? globToRegex(include) : undefined;
      const results = await nodeGrep(searchPath, regex, includeRegex, exclude?.regex, filesOnly, limit);
      if (results.length === 0) {
        return { output: "No matches found.", isError: false };
      }
      const output = results.slice(0, limit).join("\n") + (results.length > limit ? capNotice : "");
      return { output, isError: false };
    } catch (err) {
      return { output: `Search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
