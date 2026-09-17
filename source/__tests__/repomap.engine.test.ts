import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMapEngine } from "../repomap/engine.js";
import { runShell } from "../utils/worktree.js";

describe("RepoMapEngine", () => {
  let tempDir: string;

  beforeEach(async () => {
    RepoMapEngine.resetInstances();
    tempDir = await mkdtemp(join(tmpdir(), "agav-repomap-test-"));

    // Create a mock repository structure
    await mkdir(join(tempDir, "src", "sub"), { recursive: true });
    await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(tempDir, ".git"), { recursive: true });

    // File 1: helper.ts
    await writeFile(
      join(tempDir, "src", "helper.ts"),
      `export function formatOutput(data: string): string {\n  return "formatted: " + data;\n}\n\nexport class HelperService {\n  public run(): void {}\n}\n`
    );

    // File 2: index.ts (imports helper.js)
    await writeFile(
      join(tempDir, "src", "index.ts"),
      `import { formatOutput, HelperService } from "./helper.js";\n\nexport function runMain(): void {\n  formatOutput("test");\n}\n\nexport const APP_NAME = "AgavApp";\n`
    );

    // File 3: sub/math.ts
    await writeFile(
      join(tempDir, "src", "sub", "math.ts"),
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport const PI = 3.14159;\n`
    );

    // File 4: node_modules/pkg/ignored.ts (should be skipped)
    await writeFile(
      join(tempDir, "node_modules", "pkg", "ignored.ts"),
      `export function ignored(): void {}\n`
    );
  });

  afterEach(async () => {
    RepoMapEngine.resetInstances();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("creates singleton instance for a given workspace", () => {
    const engine1 = RepoMapEngine.getInstance(tempDir);
    const engine2 = RepoMapEngine.getInstance(tempDir);
    expect(engine1).toBe(engine2);
    expect(engine1.cwd).toBe(tempDir);
  });

  it("scans directory, respects SKIP_DIRS, and builds DirectedSymbolGraph", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);
    const graph = await engine.buildGraph();

    const files = graph.getFiles();
    const filePaths = files.map((f) => f.path).sort();

    // node_modules and .git should be skipped
    expect(filePaths).toEqual(["src/helper.ts", "src/index.ts", "src/sub/math.ts"]);

    // Symbols should be extracted
    const symbols = graph.getSymbols();
    const symbolNames = symbols.map((s) => s.name);
    expect(symbolNames).toContain("formatOutput");
    expect(symbolNames).toContain("HelperService");
    expect(symbolNames).toContain("runMain");
    expect(symbolNames).toContain("APP_NAME");
    expect(symbolNames).toContain("add");
    expect(symbolNames).toContain("PI");
    expect(symbolNames).not.toContain("ignored");

    // Containment edges should connect files to symbols
    const helperFileId = "file:src/helper.ts";
    const helperOutEdges = graph.getOutEdges(helperFileId);
    const containmentEdges = helperOutEdges.filter((e) => e.kind === "containment");
    expect(containmentEdges.length).toBeGreaterThanOrEqual(2);

    // Relative import resolution: index.ts imports ./helper.js -> cross-file edge index -> helper
    const indexFileId = "file:src/index.ts";
    const indexOutEdges = graph.getOutEdges(indexFileId);
    const importEdge = indexOutEdges.find(
      (e) => e.to === helperFileId && e.kind === "import"
    );
    expect(importEdge).toBeDefined();
  });

  it("generates stable repository map with global PageRank fitting within budget", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);
    const result = await engine.generateStableMap(800);

    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.symbolCount).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(800);
    expect(result.text).toContain("src/helper.ts:");
    expect(result.text).toContain("formatOutput");
    expect(result.topFiles.length).toBeGreaterThan(0);

    // Subsequent call with identical budget returns cached result
    const cachedResult = await engine.generateStableMap(800);
    expect(cachedResult).toBe(result);
  });

  it("generates personalized focus map prioritizing seed files", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);
    const result = await engine.generateFocusMap(["src/sub/math.ts"], 300);

    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(300);
    expect(result.text).toContain("src/sub/math.ts:");
    expect(result.text).toContain("add");
    expect(result.topFiles[0]?.file).toBe("src/sub/math.ts");
  });

  it("generates overview map with optional path scoping and custom budget", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);

    // Scoped overview for sub directory
    const scopedResult = await engine.generateOverview({
      path: "src/sub",
      budget: 500,
    });

    expect(scopedResult.fileCount).toBe(1);
    expect(scopedResult.text).toContain("src/sub/math.ts:");
    expect(scopedResult.text).not.toContain("src/helper.ts:");

    // Full overview with focusFiles
    const fullResult = await engine.generateOverview({
      budget: 1000,
      focusFiles: ["src/helper.ts"],
    });

    expect(fullResult.fileCount).toBe(3);
    expect(fullResult.topFiles[0]?.file).toBe("src/helper.ts");
  });

  it("incrementally updates cache and rebuilds graph when a file is modified", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);
    const initialResult = await engine.generateStableMap(800);
    expect(initialResult.text).not.toContain("newFunctionAdded");

    // Modify helper.ts by adding a new function
    const helperPath = join(tempDir, "src", "helper.ts");
    await writeFile(
      helperPath,
      `export function formatOutput(data: string): string {\n  return "formatted: " + data;\n}\n\nexport function newFunctionAdded(): boolean {\n  return true;\n}\n`
    );

    // Touch mtime ahead by 5 seconds to ensure mtime check triggers
    const futureTime = new Date(Date.now() + 5000);
    await utimes(helperPath, futureTime, futureTime);

    // Update cache and verify detection
    const isDirty = await engine.updateCache();
    expect(isDirty).toBe(true);

    const updatedResult = await engine.generateStableMap(800);
    expect(updatedResult.text).toContain("newFunctionAdded");
  });

  it("handles newly added files and removed files in incremental updates", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);
    await engine.buildGraph();
    expect(engine.fileCache.size).toBe(3);

    // Add a new file
    const newFilePath = join(tempDir, "src", "extra.ts");
    await writeFile(newFilePath, `export const EXTRA_VAR = 42;\n`);

    let isDirty = await engine.updateCache();
    expect(isDirty).toBe(true);
    expect(engine.fileCache.size).toBe(4);
    expect(engine.fileCache.has("src/extra.ts")).toBe(true);

    // Remove the added file
    await rm(newFilePath);
    isDirty = await engine.updateCache();
    expect(isDirty).toBe(true);
    expect(engine.fileCache.size).toBe(3);
    expect(engine.fileCache.has("src/extra.ts")).toBe(false);
  });

  it("extracts mentioned files from text for seed discovery", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);
    await engine.buildGraph();

    const seedsFromPath = engine.findMentionedFiles("Please check src/sub/math.ts for bugs.");
    expect(seedsFromPath).toContain("src/sub/math.ts");

    const seedsFromBasename = engine.findMentionedFiles("Can you inspect helper.ts?");
    expect(seedsFromBasename).toContain("src/helper.ts");

    const emptySeeds = engine.findMentionedFiles("How is the weather today?");
    expect(emptySeeds).toHaveLength(0);

    const asyncSeeds = await engine.extractSeeds("Look at index.ts please.");
    expect(asyncSeeds).toContain("src/index.ts");
  });

  it("executes shell commands successfully with runShell on the current platform", async () => {
    const result = await runShell("node -e \"console.log('shell_test_ok')\"");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("shell_test_ok");

    const errorResult = await runShell("node -e \"process.exit(1)\"");
    expect(errorResult.exitCode).toBe(1);
  });
});
