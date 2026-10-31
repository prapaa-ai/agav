import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { overviewTool } from "../tools/overview.js";

const PINNED_REVISION = "da6cb04937291db5b0a609338dd2d2d8dc00c73c";
const CANONICAL_DOC_PATH = resolve("docs/code-wiki/overview.md");
const GENERATED_DOC_PATH = resolve("docs/code-wiki/generated/overview.md");
const OVERVIEW_SOURCE_PATH = resolve("source/tools/overview.ts");
const REGISTRY_FACTORY_PATH = resolve("source/tools/registry-factory.ts");
const DOC_GEN_SKILL_PATH = resolve("source/skills/bundled/doc-gen/SKILL.md");

describe("code-wiki reference: overview module", () => {
  it("records assessed repository revision and bounds module scope strictly", async () => {
    const docContent = await readFile(CANONICAL_DOC_PATH, "utf-8");

    // Must record the exact pinned revision
    expect(docContent).toContain(PINNED_REVISION);

    // Must explicitly declare boundary and disclaim whole-repo coverage
    expect(docContent).toContain("source/tools/overview.ts");
    expect(docContent).toMatch(/does\s*(\*\*)?not(\*\*)?\s*claim coverage of the whole repository/i);
  });

  it("records separate output locations and overwrite/review governance rules", async () => {
    const canonical = await readFile(CANONICAL_DOC_PATH, "utf-8");
    const generated = await readFile(GENERATED_DOC_PATH, "utf-8");

    // Both files must exist and reference their distinct roles
    expect(canonical).toContain("docs/code-wiki/overview.md");
    expect(canonical).toContain("docs/code-wiki/generated/overview.md");
    expect(canonical).toMatch(/automated generators\s*(\*\*)?must never(\*\*)?\s*silently overwrite/i);

    expect(generated).toContain("GENERATED OUTPUT ARTIFACT");
    expect(generated).toContain("docs/code-wiki/overview.md");
    expect(generated).toContain(PINNED_REVISION);
  });

  it("verifies that all cited source lines exist and match code symbols at the pinned revision", async () => {
    const docContent = await readFile(CANONICAL_DOC_PATH, "utf-8");
    const sourceContent = await readFile(OVERVIEW_SOURCE_PATH, "utf-8");
    // Normalize source lines, omitting trailing empty line after final newline
    const rawLines = sourceContent.split(/\r?\n/);
    const sourceLines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;

    expect(sourceLines.length).toBe(191);
    expect(sourceLines[190]).toBe("};");

    // Check specific line-anchored claims from the doc
    const verifiedAnchors: Array<{
      start: number;
      end?: number;
      expectedToken: string;
      description: string;
    }> = [
      { start: 1, end: 3, expectedToken: "node:fs/promises", description: "Imports" },
      { start: 5, end: 9, expectedToken: "SKIP_DIRS", description: "Excluded directories" },
      { start: 11, end: 21, expectedToken: "SOURCE_EXTS", description: "Supported file extensions" },
      { start: 28, end: 44, expectedToken: "SYMBOL_PATTERNS", description: "Regex symbol patterns" },
      { start: 47, end: 60, expectedToken: "function extractSymbols", description: "Symbol extraction logic" },
      { start: 62, end: 102, expectedToken: "async function walkDir", description: "Directory traversal" },
      { start: 79, end: 83, expectedToken: "entries.sort", description: "Directory sorting" },
      { start: 104, end: 129, expectedToken: "function formatTree", description: "Tree formatting" },
      { start: 131, end: 191, expectedToken: "export const overviewTool: ToolDefinition", description: "Entry point definition" },
      { start: 155, end: 190, expectedToken: "async execute(input)", description: "Tool execute implementation" },
      { start: 162, expectedToken: "const maxFiles = 200;", description: "Hard-coded max files ceiling" },
      { start: 175, end: 177, expectedToken: "No source files found.", description: "Empty directory result" },
      { start: 182, end: 185, expectedToken: "File limit reached", description: "Truncation notice" },
    ];

    for (const anchor of verifiedAnchors) {
      const { start, end = start, expectedToken, description } = anchor;
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeLessThanOrEqual(sourceLines.length);

      const slice = sourceLines.slice(start - 1, end).join("\n");
      expect(
        slice.includes(expectedToken),
        `Anchor for ${description} (lines ${start}-${end}) must contain "${expectedToken}"`,
      ).toBe(true);

      // Verify that the link is present in the document
      const linkPattern = new RegExp(`source/tools/overview\\.ts#L${start}(?:-L${end})?`);
      expect(docContent).toMatch(linkPattern);
    }
  });

  it("checks stale/broken link detection on an intentional out-of-bounds fixture", async () => {
    const sourceContent = await readFile(OVERVIEW_SOURCE_PATH, "utf-8");
    const rawLines = sourceContent.split(/\r?\n/);
    const sourceLines = rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
    const maxLine = sourceLines.length;

    // Helper validating a file-line reference against the pinned file
    function validateSourceReference(target: string, symbol?: string): { valid: boolean; reason?: string } {
      const match = target.match(/^([^#]+)#L(\d+)(?:-L(\d+))?$/);
      if (!match) return { valid: false, reason: "Malformed reference format" };
      const [, file, startStr, endStr] = match;
      if (!file.endsWith("source/tools/overview.ts")) {
        return { valid: false, reason: `Unknown file: ${file}` };
      }
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : start;

      if (start < 1 || end > maxLine || start > end) {
        return { valid: false, reason: `Line range ${start}-${end} out of bounds (file has ${maxLine} lines)` };
      }

      if (symbol) {
        const slice = sourceLines.slice(start - 1, end).join("\n");
        if (!slice.includes(symbol)) {
          return { valid: false, reason: `Symbol "${symbol}" not found in lines ${start}-${end}` };
        }
      }

      return { valid: true };
    }

    // 1. Valid link passes
    const validCheck = validateSourceReference("source/tools/overview.ts#L131-L191", "overviewTool");
    expect(validCheck.valid).toBe(true);

    // 2. Out-of-bounds line 250 is correctly detected as broken
    const staleLineCheck = validateSourceReference("source/tools/overview.ts#L250");
    expect(staleLineCheck.valid).toBe(false);
    expect(staleLineCheck.reason).toContain("out of bounds");

    // 3. Non-existent symbol is correctly detected as broken
    const staleSymbolCheck = validateSourceReference("source/tools/overview.ts#L10", "nonExistentExport");
    expect(staleSymbolCheck.valid).toBe(false);
    expect(staleSymbolCheck.reason).toContain('Symbol "nonExistentExport" not found');
  });

  it("verifies grounded dependencies across imports, tool registry, and doc-gen skill", async () => {
    // 1. Check imports in overview.ts
    const sourceContent = await readFile(OVERVIEW_SOURCE_PATH, "utf-8");
    expect(sourceContent).toContain('import { readdir, readFile, stat } from "node:fs/promises";');
    expect(sourceContent).toContain('import { join, relative, extname, resolve } from "node:path";');
    expect(sourceContent).toContain('import type { ToolDefinition, ToolResult } from "./types.js";');

    // 2. Check registration in registry-factory.ts
    const registryContent = await readFile(REGISTRY_FACTORY_PATH, "utf-8");
    expect(registryContent).toContain('import { overviewTool } from "./overview.js";');
    expect(registryContent).toMatch(/BUILTIN_TOOLS\s*=\s*\[[\s\S]*?overviewTool/);

    // 3. Check allowed-tools and instruction in doc-gen SKILL.md
    const skillContent = await readFile(DOC_GEN_SKILL_PATH, "utf-8");
    expect(skillContent).toMatch(/allowed-tools:.*overview/);
    expect(skillContent).toContain("Use overview and find_files to understand the project structure");
  });

  it("verifies schema and execution behavior match documentation without invented guarantees", async () => {
    expect(overviewTool.schema.name).toBe("overview");
    expect(overviewTool.schema.description).toContain("Get a high-level map of the codebase");

    const inputSchema = overviewTool.schema.inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
    };
    expect(inputSchema.type).toBe("object");
    expect(inputSchema.properties.path.type).toBe("string");
    expect(inputSchema.properties.depth.type).toBe("integer");

    // Depth input validation check
    const invalidDepthResult = await overviewTool.execute({ depth: -1 });
    expect(invalidDepthResult.isError).toBe(true);
    expect(invalidDepthResult.output).toBe("Depth must be a non-negative safe integer.");

    // Missing directory check
    const missingDirResult = await overviewTool.execute({ path: "non/existent/directory/path" });
    expect(missingDirResult.isError).toBe(true);
    expect(missingDirResult.output).toContain("Directory not found:");
  });
});
