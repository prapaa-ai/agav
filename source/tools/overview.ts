import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "build", "dist", ".next", ".agav",
  ".agav-worktrees", "coverage", "__pycache__", ".venv", "venv",
  "target", ".cache", ".turbo",
]);

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".go",
  ".rs",
  ".java", ".kt",
  ".c", ".cpp", ".h", ".hpp",
  ".rb",
  ".swift",
  ".vue", ".svelte",
]);

interface FileSymbols {
  path: string;
  symbols: string[];
}

const SYMBOL_PATTERNS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^export\s+(?:async\s+)?function\s+(\w+)/gm, (m) => `${m[1]}()`],
  [/^export\s+(?:default\s+)?class\s+(\w+)/gm, (m) => `${m[1]} (class)`],
  [/^export\s+(?:default\s+)?interface\s+(\w+)/gm, (m) => `${m[1]} (interface)`],
  [/^export\s+type\s+(\w+)/gm, (m) => `${m[1]} (type)`],
  [/^export\s+const\s+(\w+)/gm, (m) => m[1]!],
  [/^export\s+enum\s+(\w+)/gm, (m) => `${m[1]} (enum)`],
  [/^def\s+(\w+)\s*\(/gm, (m) => `${m[1]}()`],
  [/^class\s+(\w+)[\s:(]/gm, (m) => `${m[1]} (class)`],
  [/^func\s+(\w+)\s*\(/gm, (m) => `${m[1]}()`],
  [/^type\s+(\w+)\s+struct/gm, (m) => `${m[1]} (struct)`],
  [/^type\s+(\w+)\s+interface/gm, (m) => `${m[1]} (interface)`],
  [/^pub\s+(?:async\s+)?fn\s+(\w+)/gm, (m) => `${m[1]}()`],
  [/^pub\s+struct\s+(\w+)/gm, (m) => `${m[1]} (struct)`],
  [/^pub\s+enum\s+(\w+)/gm, (m) => `${m[1]} (enum)`],
  [/^pub\s+trait\s+(\w+)/gm, (m) => `${m[1]} (trait)`],
];

/** Collect lightweight symbol names from a source file without parsing full syntax trees. */
function extractSymbols(content: string): string[] {
  const symbols: string[] = [];
  for (const [pattern, format] of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const sym = format(match);
      if (sym && !symbols.includes(sym)) {
        symbols.push(sym);
      }
    }
  }
  return symbols;
}

async function walkDir(
  dir: string,
  basePath: string,
  results: FileSymbols[],
  maxFiles: number,
): Promise<void> {
  if (results.length >= maxFiles) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (results.length >= maxFiles) return;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walkDir(join(dir, entry.name), basePath, results, maxFiles);
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      const filePath = relative(basePath, join(dir, entry.name));
      try {
        const content = await readFile(join(dir, entry.name), "utf-8");
        const symbols = extractSymbols(content);
        results.push({ path: filePath, symbols });
      } catch {
        results.push({ path: filePath, symbols: [] });
      }
    }
  }
}

function formatTree(files: FileSymbols[]): string {
  const tree = new Map<string, FileSymbols[]>();

  for (const file of files) {
    const parts = file.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir)!.push(file);
  }

  const lines: string[] = [];

  for (const [dir, dirFiles] of tree) {
    lines.push(`${dir}/`);
    for (const file of dirFiles) {
      const fileName = file.path.split("/").pop()!;
      if (file.symbols.length > 0) {
        lines.push(`  ${fileName} — ${file.symbols.join(", ")}`);
      } else {
        lines.push(`  ${fileName}`);
      }
    }
  }

  return lines.join("\n");
}

export const overviewTool: ToolDefinition = {
  schema: {
    name: "overview",
    description:
      "Get a high-level map of the codebase showing file structure and key symbols " +
      "(functions, classes, types, interfaces) per file. Use this first to understand " +
      "a project's layout before diving into specific files with read_file or grep_search. " +
      "Returns a condensed tree — not file contents, just the skeleton.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to map (default: current directory). Use a subdirectory to focus on a specific area.",
        },
        depth: {
          type: "number",
          description: "Max directory depth to traverse (default: 6).",
        },
      },
    },
  },

  async execute(input): Promise<ToolResult> {
    const searchPath = String(input.path ?? ".");
    const maxFiles = 200;
    const results: FileSymbols[] = [];

    const absPath = join(process.cwd(), searchPath);

    try {
      await stat(absPath);
    } catch {
      return { output: `Directory not found: ${searchPath}`, isError: true };
    }

    await walkDir(absPath, absPath, results, maxFiles);

    if (results.length === 0) {
      return { output: "No source files found.", isError: false };
    }

    const tree = formatTree(results);
    const summary = `${results.length} files, ${results.reduce((n, f) => n + f.symbols.length, 0)} symbols`;

    return {
      output: `${summary}\n\n${tree}`,
      isError: false,
    };
  },
};
