import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMapEngine } from "../repomap/engine.js";
import { safeParser } from "../repomap/parser/safe-parser.js";
import { overviewTool } from "../tools/overview.js";
import { DirectedSymbolGraph } from "../repomap/graph/symbol-graph.js";
import { computeGlobalPageRank } from "../repomap/graph/pagerank.js";
import { fitToBudget } from "../repomap/budget/binary-search-fit.js";

describe("P1.3 Comprehensive RepoMap Verification Suite", () => {
  let tempDir: string;

  beforeEach(async () => {
    RepoMapEngine.resetInstances();
    tempDir = await mkdtemp(join(tmpdir(), "agav-repomap-comp-"));
  });

  afterEach(async () => {
    RepoMapEngine.resetInstances();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("handles empty repository with zero source files gracefully", async () => {
    const engine = RepoMapEngine.getInstance(tempDir);
    const stableMap = await engine.generateStableMap(800);
    expect(stableMap.fileCount).toBe(0);
    expect(stableMap.symbolCount).toBe(0);
    expect(stableMap.text).toBe("");
    expect(stableMap.topFiles).toEqual([]);

    const focusMap = await engine.generateFocusMap(["nonexistent.ts"], 300);
    expect(focusMap.fileCount).toBe(0);
    expect(focusMap.text).toBe("");

    const overview = await engine.generateOverview({ budget: 500 });
    expect(overview.fileCount).toBe(0);
    expect(overview.text).toBe("");
  });

  it("handles malformed/syntax error files gracefully without crashing", async () => {
    const malformedFile = join(tempDir, "broken.ts");
    await writeFile(malformedFile, `
      export function badSyntax( {
        const x = ;
        return ???
    `);

    const result = safeParser.parse("broken.ts", `export function badSyntax( { return ???`);
    // Safe parser and TS/regex extractor fallback should not throw
    expect(result).toBeDefined();
    expect(Array.isArray(result.symbols)).toBe(true);

    const engine = RepoMapEngine.getInstance(tempDir);
    const map = await engine.generateStableMap(800);
    expect(map).toBeDefined();
    // Doesn't crash, returns valid result
    expect(typeof map.text).toBe("string");
  });

  it("disambiguates duplicate symbol names across different files", async () => {
    await mkdir(join(tempDir, "moduleA"), { recursive: true });
    await mkdir(join(tempDir, "moduleB"), { recursive: true });

    await writeFile(
      join(tempDir, "moduleA", "service.ts"),
      `export class DataService { public fetch(): string { return "A"; } }\n`
    );
    await writeFile(
      join(tempDir, "moduleB", "service.ts"),
      `export class DataService { public fetch(): string { return "B"; } }\n`
    );

    const engine = RepoMapEngine.getInstance(tempDir);
    const graph = await engine.buildGraph();
    const symbols = graph.getSymbols();

    const dataServices = symbols.filter((s) => s.name === "DataService");
    expect(dataServices.length).toBe(2);
    // IDs must be unique and contain their respective file paths
    expect(dataServices[0]?.id).not.toBe(dataServices[1]?.id);
    expect(dataServices.some((s) => s.id.includes("moduleA/service.ts"))).toBe(true);
    expect(dataServices.some((s) => s.id.includes("moduleB/service.ts"))).toBe(true);
  });

  it("strictly enforces token budget under extreme constraints", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(tempDir, "src", `file${i}.ts`),
        `export function fn${i}A() {}\nexport function fn${i}B() {}\nexport class Cls${i} {}\n`
      );
    }

    const engine = RepoMapEngine.getInstance(tempDir);

    // Very small budget: 10 tokens
    const tinyResult = await engine.generateStableMap(10);
    expect(tinyResult.tokenCount).toBeLessThanOrEqual(10);

    // Medium budget: 200 tokens
    const medResult = await engine.generateStableMap(200);
    expect(medResult.tokenCount).toBeLessThanOrEqual(200);

    // Large budget: 5000 tokens
    const largeResult = await engine.generateStableMap(5000);
    expect(largeResult.tokenCount).toBeLessThanOrEqual(5000);
    expect(largeResult.symbolCount).toBeGreaterThanOrEqual(medResult.symbolCount);
  });

  it("extracts JavaScript CommonJS and ESM symbols accurately", async () => {
    await writeFile(
      join(tempDir, "index.js"),
      `
const { helper } = require('./helper');

function startApp() {
  return helper();
}

class AppController {
  handle() {}
}

module.exports = { startApp, AppController };
`
    );

    const engine = RepoMapEngine.getInstance(tempDir);
    const graph = await engine.buildGraph();
    const symbols = graph.getSymbols();
    const names = symbols.map((s) => s.name);

    expect(names).toContain("startApp");
    expect(names).toContain("AppController");
  });

  it("isolates subagent CWD workspace in overviewTool (P0.1 compatibility)", async () => {
    // Create main repo structure
    await mkdir(join(tempDir, "main_src"), { recursive: true });
    await writeFile(
      join(tempDir, "main_src", "root.ts"),
      `export function rootFunction(): void {}\n`
    );

    // Create subagent isolated worktree directory
    const subagentDir = join(tempDir, "subagent_worktree");
    await mkdir(join(subagentDir, "src"), { recursive: true });
    await writeFile(
      join(subagentDir, "src", "subagent_task.ts"),
      `export function isolatedSubagentWorker(): boolean { return true; }\n`
    );

    // 1. Call overviewTool with subagent context.cwd
    const subagentResult = await overviewTool.execute({}, { cwd: subagentDir });
    expect(subagentResult.isError).toBe(false);
    expect(subagentResult.output).toContain("subagent_task.ts");
    expect(subagentResult.output).toContain("isolatedSubagentWorker");
    expect(subagentResult.output).not.toContain("root.ts");

    // 2. Call overviewTool with main repo cwd
    const mainResult = await overviewTool.execute({}, { cwd: tempDir });
    expect(mainResult.isError).toBe(false);
    expect(mainResult.output).toContain("root.ts");
    expect(mainResult.output).toContain("rootFunction");
  });

  it("guarantees PageRank determinism across repeated executions", async () => {
    const graph = new DirectedSymbolGraph();
    graph.addFileNode({ path: "a.ts" });
    graph.addFileNode({ path: "b.ts" });
    graph.addFileNode({ path: "c.ts" });
    graph.addEdge("file:a.ts", "file:b.ts", "import");
    graph.addEdge("file:b.ts", "file:c.ts", "import");

    const scores1 = computeGlobalPageRank(graph, { alpha: 0.85 });
    const scores2 = computeGlobalPageRank(graph, { alpha: 0.85 });

    for (const [nodeId, score] of scores1.entries()) {
      expect(scores2.get(nodeId)).toBe(score);
    }
  });

  it("ranks entry points and heavily referenced files higher", async () => {
    const graph = new DirectedSymbolGraph();
    // 3 files (a, b, c) all import core.ts
    graph.addFileNode({ path: "core.ts" });
    graph.addFileNode({ path: "a.ts" });
    graph.addFileNode({ path: "b.ts" });
    graph.addFileNode({ path: "c.ts" });

    graph.addEdge("file:a.ts", "file:core.ts", "import");
    graph.addEdge("file:b.ts", "file:core.ts", "import");
    graph.addEdge("file:c.ts", "file:core.ts", "import");

    const scores = computeGlobalPageRank(graph, { alpha: 0.85 });
    const coreScore = scores.get("file:core.ts")!;
    const aScore = scores.get("file:a.ts")!;

    expect(coreScore).toBeGreaterThan(aScore);
  });
});
