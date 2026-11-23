import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, relative, extname, basename } from "node:path";
import { platform } from "node:os";
import type { ToolDefinition, ToolResult } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", ".next", ".venv", "__pycache__", "coverage"]);
const MAX_FILE_SIZE = 1_048_576; // 1 MB — skip files larger than this
const DEFAULT_MAX_RESULTS = 100;
const MAX_CONTEXT_LINES = 50;

interface GrepContext {
  before: number;
  after: number;
}

/** A matching or context line; line 0 marks a raw, non-matching notice such as a binary-file match. */
interface GrepLine {
  path: string;
  line: number;
  text: string;
  match: boolean;
}

/** Keep the first `limit` matches with their context, dropping context that only leads into later matches. */
function limitContextLines(lines: GrepLine[], limit: number, after: number): GrepLine[] {
  const kept: GrepLine[] = [];
  let matches = 0;
  let last: GrepLine | undefined;
  for (const line of lines) {
    if (line.match && ++matches > limit) break;
    if (line.match || matches < limit || (last && line.path === last.path && line.line <= last.line + after)) {
      kept.push(line);
    }
    if (line.match) last = line;
  }
  return kept;
}

/** Format lines like grep -nH with context: "path:N:text" for matches, "path-N-text" for context, "--" between gaps. */
function formatContextLines(lines: GrepLine[]): string[] {
  const output: string[] = [];
  let previous: GrepLine | undefined;
  for (const line of lines) {
    if (previous && (line.line === 0 || line.path !== previous.path || line.line !== previous.line + 1)) {
      output.push("--");
    }
    const separator = line.match ? ":" : "-";
    output.push(line.line === 0 ? line.text : `${line.path}${separator}${line.line}${separator}${line.text}`);
    previous = line;
  }
  return output;
}

const isNotice = (line: string) => line === "--" || /^Binary file .* matches$|: binary file matches$/.test(line);

/**
 * Parse native grep --null context output before splitting lines, so file names
 * containing newlines stay intact. Each NUL ends a path, preferably one starting
 * with `root`; only group separators and binary notices may precede it.
 */
function parseNativeContextLines(stdout: string, root: string, relativeRoot: string | undefined): GrepLine[] {
  const parsed: GrepLine[] = [];
  const display = (path: string) => relativeRoot && path.startsWith("./") ? relativeRoot + path.slice(1) : path;
  const addNotices = (lines: string[]) => {
    for (const line of lines) {
      if (line && line !== "--") {
        const text = relativeRoot ? line.replace(/^(Binary file )?\.\//, (_match, prefix = "") => `${prefix}${relativeRoot}/`) : line;
        parsed.push({ path: "", line: 0, text, match: false });
      }
    }
  };
  let rest = stdout;
  for (let nul = rest.indexOf("\0"); nul !== -1; nul = rest.indexOf("\0")) {
    const head = rest.slice(0, nul).split("\n");
    let start = 0;
    while (start < head.length - 1 && isNotice(head[start]!)) start++;
    for (let i = head.length - 1; i > start; i--) {
      if (head[i]!.startsWith(root) && head.slice(0, i).every(isNotice)) {
        start = i;
        break;
      }
    }
    addNotices(head.slice(0, start));
    const prefix = /^(\d+)([:-])/.exec(rest.slice(nul + 1));
    const end = rest.indexOf("\n", nul);
    const textEnd = end === -1 ? rest.length : end;
    if (prefix) {
      parsed.push({
        path: display(head.slice(start).join("\n")),
        line: Number(prefix[1]),
        text: rest.slice(nul + 1 + prefix[0].length, textEnd),
        match: prefix[2] === ":",
      });
    }
    rest = rest.slice(textEnd + 1);
  }
  addNotices(rest.split("\n"));
  return parsed;
}

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
  context?: GrepContext,
): Promise<{ results: string[]; matches: number }> {
  const matchesFileName = (name: string) =>
    (!include || include.test(name)) && (!exclude || !exclude.test(name));
  const results: string[] = [];
  const contextLines: GrepLine[] = [];
  let matches = 0;

  const finish = () => ({
    results: context ? formatContextLines(limitContextLines(contextLines, limit, context.after)) : results.slice(0, limit),
    matches,
  });

  function addContext(path: string, lines: string[], lineCount: number, { before, after }: GrepContext): void {
    const hits: number[] = [];
    for (let i = 0; i < lineCount && matches <= limit; i++) {
      if (pattern.test(lines[i]!)) {
        hits.push(i);
        matches++;
      }
    }
    let next = 0;
    for (const hit of hits) {
      const end = Math.min(lineCount - 1, hit + after);
      for (let i = Math.max(next, hit - before); i <= end; i++) {
        contextLines.push({ path, line: i + 1, text: lines[i]!, match: pattern.test(lines[i]!) });
      }
      next = end + 1;
    }
  }

  async function walkDir(dir: string): Promise<void> {
    if (matches > limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (filesOnly) throw error;
      return;
    }
    for (const entry of entries) {
      if (matches > limit) return;
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
          if (context) {
            addContext(fullPath, lines, lineCount, context);
            continue;
          }
          for (let i = 0; i < lineCount; i++) {
            if (matches > limit) return;
            if (pattern.test(lines[i]!)) {
              matches++;
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
          if (context) {
            addContext(searchPath, lines, lineCount, context);
            return finish();
          }
          for (let i = 0; i < lineCount; i++) {
            if (matches > limit) break;
            if (pattern.test(lines[i]!)) {
              matches++;
              results.push(filesOnly ? searchPath : `${searchPath}:${i + 1}:${lines[i]}`);
              if (filesOnly) break;
            }
          }
        }
      }
      return finish();
    }
  } catch (error) {
    if (filesOnly) throw error;
    return finish();
  }

  await walkDir(searchPath);
  return finish();
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
  context?: GrepContext,
): Promise<{ stdout: string; stderr: string; code: number | string | null; root: string; relativeRoot?: string }> {
  // grep can exclude its explicit root too; searching "." bypasses only that
  // root's name, while still excluding generated directories below it.
  const searchFromRoot = SKIP_DIRS.has(basename(searchPath)) &&
    await stat(searchPath).then((info) => info.isDirectory(), () => false);
  const args = filesOnly ? ["-rl", "-I", "--color=never"] : ["-rn", "-H", "--color=never"];
  args.push(fixedStrings ? "-F" : "-E");
  if (ignoreCase) {
    args.push("-i");
  }
  if (context) {
    args.push("-B", String(context.before), "-A", String(context.after), "--null");
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
      if (searchFromRoot && !context) {
        stdout = stdout.replace(/(^|\n)(Binary file )?\.\//g, (_match, boundary, prefix = "") => `${boundary}${prefix}${searchPath}/`);
      }
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(error);
      } else {
        resolve({
          stdout,
          stderr: stderr || (filesOnly ? error?.message : "") || "",
          code: error ? (error as NodeJS.ErrnoException).code ?? null : 0,
          root: searchFromRoot ? "." : searchPath,
          relativeRoot: searchFromRoot ? searchPath : undefined,
        });
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
      "Searches recursively from the given directory. Use exclude to skip matching file names. Use files_only for matching paths without content. Use ignore_case to match without regard to letter case. " +
      "Use context_before and context_after to include surrounding lines (path-N-text) around matches (path:N:text).",
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
        context_before: {
          type: "integer",
          minimum: 0,
          maximum: MAX_CONTEXT_LINES,
          description: "Lines of context to show before each match (default: 0). Not allowed with files_only.",
        },
        context_after: {
          type: "integer",
          minimum: 0,
          maximum: MAX_CONTEXT_LINES,
          description: "Lines of context to show after each match (default: 0). Not allowed with files_only.",
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
    for (const name of ["context_before", "context_after"]) {
      const value = input[name];
      if (value !== undefined && (
        typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_CONTEXT_LINES
      )) {
        return { output: `${name} must be an integer from 0 to ${MAX_CONTEXT_LINES}`, isError: true };
      }
    }
    const before = (input.context_before as number | undefined) ?? 0;
    const after = (input.context_after as number | undefined) ?? 0;
    if (input.files_only === true && (before > 0 || after > 0)) {
      return { output: "context_before and context_after cannot be used with files_only.", isError: true };
    }
    const context = before > 0 || after > 0 ? { before, after } : undefined;
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
        const result = await nativeGrep(pattern, searchPath, include, exclude, filesOnly, fixedStrings, ignoreCase, context);
        const incomplete = result.code !== 0 && result.code !== 1;
        const partialLine = (requestedLimit !== undefined || filesOnly) && incomplete && !result.stdout.endsWith("\n");
        const stdout = partialLine ? result.stdout.slice(0, result.stdout.lastIndexOf("\n") + 1) : result.stdout;
        const lines = stdout.split("\n").filter(Boolean);
        const contextLines = context ? parseNativeContextLines(stdout, result.root, result.relativeRoot) : undefined;
        const matchCount = contextLines ? contextLines.filter((line) => line.match).length : lines.length;
        const limited = context && contextLines
          ? formatContextLines(limitContextLines(contextLines, limit, context.after))
          : lines.slice(0, limit);
        const output = matchCount > limit
          ? limited.join("\n") + (filesOnly || requestedLimit !== undefined
            ? capNotice
            : `\n... ${matchCount - limit} more matches`)
          : contextLines ? limited.join("\n") : stdout.trimEnd();
        if ((filesOnly || requestedLimit !== undefined) && incomplete) {
          if (result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && matchCount >= limit) {
            return { output: limited.join("\n") + capNotice, isError: false };
          }
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
      const { results, matches } = await nodeGrep(searchPath, regex, includeRegex, exclude?.regex, filesOnly, limit, context);
      if (matches === 0) {
        return { output: "No matches found.", isError: false };
      }
      const output = results.join("\n") + (matches > limit ? capNotice : "");
      return { output, isError: false };
    } catch (err) {
      return { output: `Search failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};
