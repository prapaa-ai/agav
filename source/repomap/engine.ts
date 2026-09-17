import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fitToBudget } from "./budget/binary-search-fit.js";
import { computeGlobalPageRank, computePersonalizedPageRank } from "./graph/pagerank.js";
import { DirectedSymbolGraph, toFileNodeId } from "./graph/symbol-graph.js";
import { detectLanguage } from "./parser/extractors/index.js";
import { safeParser } from "./parser/safe-parser.js";
import type { ParseResult, RepoMapResult, SymbolNode } from "./types.js";

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  ".next",
  ".agav",
  ".agav-worktrees",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".cache",
  ".turbo",
  ".idea",
  ".vscode",
]);

export const SOURCE_EXTS = new Set([
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

export interface CachedFileInfo {
  relativePath: string;
  absPath: string;
  mtime: number;
  size: number;
  parseResult: ParseResult;
}

export interface OverviewOptions {
  path?: string;
  budget?: number;
  focusFiles?: string[];
  maxFiles?: number;
}

/**
 * RepoMapEngine manages repository scanning, incremental AST symbol extraction,
 * dependency graph construction, PageRank-based ranking, and token-budgeted map generation.
 */
export class RepoMapEngine {
  private static instances = new Map<string, RepoMapEngine>();

  public readonly cwd: string;
  public readonly fileCache = new Map<string, CachedFileInfo>();
  private cachedGraph: DirectedSymbolGraph | null = null;
  private stableMapCache = new Map<number, RepoMapResult>();

  constructor(cwd: string = process.cwd()) {
    this.cwd = resolve(cwd);
  }

  /**
   * Get or create the singleton instance for a specific workspace directory.
   */
  public static getInstance(cwd?: string): RepoMapEngine {
    const root = cwd ? resolve(cwd) : process.cwd();
    let instance = RepoMapEngine.instances.get(root);
    if (!instance) {
      instance = new RepoMapEngine(root);
      RepoMapEngine.instances.set(root, instance);
    }
    return instance;
  }

  /**
   * Reset all singleton instances (useful for testing).
   */
  public static resetInstances(): void {
    RepoMapEngine.instances.clear();
  }

  /**
   * Clear cached files, graph, and maps for this instance.
   */
  public clearCache(): void {
    this.fileCache.clear();
    this.cachedGraph = null;
    this.stableMapCache.clear();
  }

  /**
   * Recursively scans directory ignoring SKIP_DIRS and collects source files.
   */
  private async scanFiles(dir: string, fileList: string[], maxFiles: number): Promise<void> {
    if (fileList.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (fileList.length >= maxFiles) return;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".")) {
          continue;
        }
        await this.scanFiles(fullPath, fileList, maxFiles);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) {
          fileList.push(fullPath);
        }
      }
    }
  }

  /**
   * Incrementally updates cached parse results by checking file mtimes and sizes.
   * Returns true if any files were added, modified, or deleted.
   */
  public async updateCache(maxFiles: number = 1000): Promise<boolean> {
    const discoveredPaths: string[] = [];
    await this.scanFiles(this.cwd, discoveredPaths, maxFiles);

    const discoveredRelPaths = new Set<string>();
    let modifiedOrAdded = false;

    for (const absPath of discoveredPaths) {
      const relPath = relative(this.cwd, absPath).replace(/\\/g, "/");
      discoveredRelPaths.add(relPath);

      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch {
        continue;
      }

      const cached = this.fileCache.get(relPath);
      if (cached && cached.mtime === fileStat.mtimeMs && cached.size === fileStat.size) {
        continue;
      }

      try {
        const content = await readFile(absPath, "utf-8");
        const parseResult = safeParser.parse(relPath, content);
        this.fileCache.set(relPath, {
          relativePath: relPath,
          absPath,
          mtime: fileStat.mtimeMs,
          size: fileStat.size,
          parseResult,
        });
        modifiedOrAdded = true;
      } catch {
        if (this.fileCache.has(relPath)) {
          this.fileCache.delete(relPath);
          modifiedOrAdded = true;
        }
      }
    }

    for (const [cachedRelPath] of this.fileCache) {
      if (!discoveredRelPaths.has(cachedRelPath)) {
        this.fileCache.delete(cachedRelPath);
        modifiedOrAdded = true;
      }
    }

    if (modifiedOrAdded) {
      this.cachedGraph = null;
      this.stableMapCache.clear();
    }

    return modifiedOrAdded;
  }

  /**
   * Build or retrieve cached DirectedSymbolGraph of the repository.
   * Incremental parsing is performed if files were added or modified.
   */
  public async buildGraph(maxFiles: number = 1000): Promise<DirectedSymbolGraph> {
    const isDirty = await this.updateCache(maxFiles);
    if (this.cachedGraph && !isDirty) {
      return this.cachedGraph;
    }

    const graph = new DirectedSymbolGraph();
    const cachedFiles = Array.from(this.fileCache.values()).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    );

    const filesToInclude = maxFiles < cachedFiles.length ? cachedFiles.slice(0, maxFiles) : cachedFiles;

    const filesByPath = new Map<string, CachedFileInfo>();
    const symbolsByName = new Map<string, SymbolNode[]>();

    for (const file of filesToInclude) {
      filesByPath.set(file.relativePath, file);

      const fileNodeId = toFileNodeId(file.relativePath);
      graph.addFileNode({
        id: fileNodeId,
        path: file.relativePath,
        file: file.relativePath,
        size: file.size,
        mtime: file.mtime,
        language: detectLanguage(file.relativePath),
      });

      for (const sym of file.parseResult.symbols) {
        graph.addSymbolNode({ ...sym, filePath: file.relativePath });
        graph.addEdge(fileNodeId, sym.id, "containment", 1.0);

        if (sym.parentId) {
          graph.addEdge(sym.parentId, sym.id, "containment", 1.0);
        }

        let symList = symbolsByName.get(sym.name);
        if (!symList) {
          symList = [];
          symbolsByName.set(sym.name, symList);
        }
        symList.push(sym);
      }
    }

    // Resolve cross-file imports and references
    for (const file of filesToInclude) {
      const fileNodeId = toFileNodeId(file.relativePath);

      for (const ref of file.parseResult.references) {
        if (ref.kind === "import") {
          const targetFile = this.resolveImport(file.relativePath, ref.name, filesByPath);
          if (targetFile) {
            const targetFileId = toFileNodeId(targetFile.relativePath);
            const fromId = ref.sourceSymbolId ?? fileNodeId;
            graph.addEdge(fromId, targetFileId, "import");
          }
        } else if (ref.kind === "call" || ref.kind === "inheritance" || ref.kind === "type_ref") {
          const candidates = symbolsByName.get(ref.name);
          if (candidates && candidates.length > 0 && ref.sourceSymbolId) {
            const localCandidate = candidates.find((s) => s.filePath === file.relativePath);
            const targetSym = localCandidate ?? (candidates.length === 1 ? candidates[0] : undefined);
            if (targetSym && targetSym.id !== ref.sourceSymbolId) {
              graph.addEdge(ref.sourceSymbolId, targetSym.id, ref.kind);
            }
          }
        }
      }
    }

    this.cachedGraph = graph;
    return graph;
  }

  /**
   * Resolves relative imports (e.g. `./foo.js`, `../bar`, `./types`) or package-relative paths.
   */
  private resolveImport(
    sourceFilePath: string,
    importPath: string,
    filesByPath: Map<string, CachedFileInfo>
  ): CachedFileInfo | undefined {
    if (importPath.startsWith(".")) {
      const currentDir = dirname(sourceFilePath);
      const normalizedBase = normalize(join(currentDir, importPath)).replace(/\\/g, "/");

      // 1. Direct match
      if (filesByPath.has(normalizedBase)) {
        return filesByPath.get(normalizedBase);
      }

      // 2. ESM .js/.jsx/.mjs/.cjs mapping to .ts/.tsx
      if (/\.(m|c)?jsx?$/.test(normalizedBase)) {
        const baseNoExt = normalizedBase.replace(/\.(m|c)?jsx?$/, "");
        const candidates = [
          `${baseNoExt}.ts`,
          `${baseNoExt}.tsx`,
          `${baseNoExt}.d.ts`,
          `${baseNoExt}.js`,
          `${baseNoExt}.jsx`,
        ];
        for (const cand of candidates) {
          if (filesByPath.has(cand)) {
            return filesByPath.get(cand);
          }
        }
      }

      // 3. Extension-less imports
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]) {
        const candidate = `${normalizedBase}${ext}`;
        if (filesByPath.has(candidate)) {
          return filesByPath.get(candidate);
        }
      }

      // 4. Index files inside directory
      for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py", "mod.rs"]) {
        const candidate = `${normalizedBase}/${idx}`;
        if (filesByPath.has(candidate)) {
          return filesByPath.get(candidate);
        }
      }
    } else {
      if (filesByPath.has(importPath)) {
        return filesByPath.get(importPath);
      }
      const pyCandidate = importPath.replace(/\./g, "/") + ".py";
      if (filesByPath.has(pyCandidate)) {
        return filesByPath.get(pyCandidate);
      }
    }

    return undefined;
  }

  /**
   * Generate stable repository skeleton map using global PageRank (alpha=0.85) and binary search fitting.
   * Default 800 tokens. Result is cached until files are modified.
   */
  public async generateStableMap(budgetTokens: number = 800): Promise<RepoMapResult> {
    const isDirty = await this.updateCache();
    if (!isDirty && this.stableMapCache.has(budgetTokens)) {
      return this.stableMapCache.get(budgetTokens)!;
    }

    const graph = await this.buildGraph();
    const files = graph.getFiles();
    const symbols = graph.getSymbols();

    if (files.length === 0) {
      return { text: "", tokenCount: 0, fileCount: 0, symbolCount: 0, topFiles: [] };
    }

    const scores = computeGlobalPageRank(graph, { alpha: 0.85, normalization: "max" });
    const fit = fitToBudget(files, symbols, scores, budgetTokens);

    const topFiles = fit.selectedFiles
      .map((fid) => ({ file: fid.replace(/^file:/, ""), score: scores.get(fid) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    const result: RepoMapResult = {
      text: fit.text,
      tokenCount: fit.tokenCount,
      fileCount: fit.selectedFiles.length,
      symbolCount: fit.selectedSymbols.length,
      topFiles,
    };

    this.stableMapCache.set(budgetTokens, result);
    return result;
  }

  /**
   * Generate focus map seeded on focusFiles using personalized PageRank and binary search fitting.
   * Default 300 tokens.
   */
  public async generateFocusMap(
    focusFiles: string[],
    budgetTokens: number = 300
  ): Promise<RepoMapResult> {
    const graph = await this.buildGraph();
    const files = graph.getFiles();
    const symbols = graph.getSymbols();

    if (files.length === 0 || focusFiles.length === 0) {
      return { text: "", tokenCount: 0, fileCount: 0, symbolCount: 0, topFiles: [] };
    }

    const allFilePaths = files.map((f) => f.path ?? f.file ?? "");
    const normalizedSeeds: string[] = [];

    for (const seed of focusFiles) {
      const clean = seed.replace(/^file:/, "").replace(/\\/g, "/");
      const exact = allFilePaths.find(
        (p) => p === clean || p.endsWith("/" + clean) || p.endsWith(clean)
      );
      if (exact) {
        normalizedSeeds.push(exact);
      } else {
        normalizedSeeds.push(clean);
      }
    }

    const scores = computePersonalizedPageRank(graph, normalizedSeeds, {
      alpha: 0.85,
      normalization: "max",
    });
    const fit = fitToBudget(files, symbols, scores, budgetTokens);

    const topFiles = fit.selectedFiles
      .map((fid) => ({ file: fid.replace(/^file:/, ""), score: scores.get(fid) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    return {
      text: fit.text,
      tokenCount: fit.tokenCount,
      fileCount: fit.selectedFiles.length,
      symbolCount: fit.selectedSymbols.length,
      topFiles,
    };
  }

  /**
   * Generate high-level overview map with optional directory path scoping,
   * focus seeds, and token budget.
   */
  public async generateOverview(options?: OverviewOptions): Promise<RepoMapResult> {
    const budget = options?.budget ?? 1200;
    const graph = await this.buildGraph(options?.maxFiles);

    let files = graph.getFiles();
    let symbols = graph.getSymbols();

    if (options?.path && options.path !== "." && options.path !== "") {
      const filterPath = options.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
      files = files.filter((f) => {
        const p = (f.path ?? f.file ?? "").replace(/\\/g, "/");
        return p === filterPath || p.startsWith(filterPath + "/");
      });

      const allowedFilePaths = new Set(files.map((f) => f.path ?? f.file ?? ""));
      symbols = symbols.filter((s) => {
        const p = (s.filePath ?? s.file ?? "").replace(/\\/g, "/");
        return allowedFilePaths.has(p);
      });
    }

    if (files.length === 0) {
      return { text: "", tokenCount: 0, fileCount: 0, symbolCount: 0, topFiles: [] };
    }

    let scores: Map<string, number>;
    if (options?.focusFiles && options.focusFiles.length > 0) {
      const allFilePaths = files.map((f) => f.path ?? f.file ?? "");
      const normalizedSeeds: string[] = [];
      for (const seed of options.focusFiles) {
        const clean = seed.replace(/^file:/, "").replace(/\\/g, "/");
        const exact = allFilePaths.find(
          (p) => p === clean || p.endsWith("/" + clean) || p.endsWith(clean)
        );
        normalizedSeeds.push(exact ?? clean);
      }
      scores = computePersonalizedPageRank(graph, normalizedSeeds, {
        alpha: 0.85,
        normalization: "max",
      });
    } else {
      scores = computeGlobalPageRank(graph, { alpha: 0.85, normalization: "max" });
    }

    const fit = fitToBudget(files, symbols, scores, budget);
    const topFiles = fit.selectedFiles
      .map((fid) => ({ file: fid.replace(/^file:/, ""), score: scores.get(fid) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    return {
      text: fit.text,
      tokenCount: fit.tokenCount,
      fileCount: fit.selectedFiles.length,
      symbolCount: fit.selectedSymbols.length,
      topFiles,
    };
  }

  /**
   * Asynchronously extracts seeds by ensuring cache is populated first.
   */
  public async extractSeeds(text: string): Promise<string[]> {
    if (!text || typeof text !== "string") return [];
    if (this.fileCache.size === 0) {
      await this.updateCache();
    }
    return this.findMentionedFiles(text);
  }

  /**
   * Searches a given text for mentions of known repository files (full paths or basenames).
   */
  public findMentionedFiles(text: string): string[] {
    if (!text || typeof text !== "string") return [];

    const found = new Set<string>();
    const allFiles = Array.from(this.fileCache.keys());
    if (allFiles.length === 0) return [];

    const lowerText = text.toLowerCase();

    for (const file of allFiles) {
      const normalizedFile = file.toLowerCase();
      if (
        lowerText.includes(normalizedFile) ||
        lowerText.includes(normalizedFile.replace(/\//g, "\\"))
      ) {
        found.add(file);
        continue;
      }

      const basename = file.split("/").pop()!;
      if (basename && basename.length > 3 && basename.includes(".")) {
        const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\b${escaped}\\b`, "i");
        if (regex.test(text)) {
          found.add(file);
        }
      }
    }

    return Array.from(found);
  }
}
