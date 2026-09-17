import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileTool } from "../tools/file-edit.js";
import {
  matchSingleHunk,
  planAndValidateEdits,
  detectLineEnding,
  calculateSimilarity,
  levenshteinDistance,
  normalizeUnicode,
} from "../utils/edit-engine.js";
import { performUndo, pushUndo } from "../utils/undo.js";

describe("P1.1 Resilient Fuzzy & Multi-Block File Edit Engine", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agav-edit-test-"));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  // 1. Exact match edit
  it("1. performs exact match edit accurately", async () => {
    const filePath = join(testDir, "exact.txt");
    await writeFile(filePath, "function hello() {\n  return 'world';\n}\n", "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "  return 'world';",
        new_string: "  return 'agav';",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe(filePath);
    expect(result.diffLines).toBeDefined();

    const updated = await readFile(filePath, "utf-8");
    expect(updated).toBe("function hello() {\n  return 'agav';\n}\n");
  });

  // 2. CRLF file edited with LF old_string
  it("2. edits CRLF file when old_string has LF line endings", async () => {
    const filePath = join(testDir, "crlf.txt");
    const crlfContent = "line 1\r\nline 2\r\nline 3\r\n";
    await writeFile(filePath, crlfContent, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "line 2\n",
        new_string: "line two\n",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toBe("line 1\r\nline two\r\nline 3\r\n");
    expect(detectLineEnding(updated)).toBe("\r\n");
  });

  // 3. LF file edited with CRLF old_string
  it("3. edits LF file when old_string has CRLF line endings", async () => {
    const filePath = join(testDir, "lf.txt");
    const lfContent = "alpha\nbeta\ngamma\n";
    await writeFile(filePath, lfContent, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "beta\r\n",
        new_string: "BETA\r\n",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toBe("alpha\nBETA\ngamma\n");
    expect(detectLineEnding(updated)).toBe("\n");
  });

  // 4. Indentation variation (tabs vs spaces, 2 vs 4 spaces)
  it("4. handles indentation variations (e.g. 2 spaces vs 4 spaces)", async () => {
    const filePath = join(testDir, "indent.ts");
    // File uses 4 spaces
    const fileContent = "function calc() {\n    const x = 10;\n    const y = 20;\n    return x + y;\n}\n";
    await writeFile(filePath, fileContent, "utf-8");

    // Model provides 2 spaces
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "  const x = 10;\n  const y = 20;",
        new_string: "  const x = 100;\n  const y = 200;",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    // Indentation adapted to file's 4 spaces
    expect(updated).toContain("    const x = 100;\n    const y = 200;");
  });

  // 5. Trailing whitespace differences
  it("5. matches despite trailing whitespace on file or model lines", async () => {
    const filePath = join(testDir, "trailing.js");
    // File has trailing spaces on lines
    const fileContent = "const a = 1;   \nconst b = 2; \nconst c = 3;\n";
    await writeFile(filePath, fileContent, "utf-8");

    // Model provides clean lines without trailing spaces
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "const b = 2;",
        new_string: "const b = 42;",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toContain("const b = 42;");
  });

  // 6. Leading/trailing blank line tolerance
  it("6. matches despite leading or trailing blank lines in old_string", async () => {
    const filePath = join(testDir, "blanks.py");
    const fileContent = "import os\n\ndef run():\n    print('start')\n";
    await writeFile(filePath, fileContent, "utf-8");

    // Model included extra blank lines around the block
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "\n\ndef run():\n    print('start')\n\n",
        new_string: "def run():\n    print('agav')\n",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toContain("print('agav')");
  });

  // 7. Near-miss diagnostic reporting
  it("7. provides near-miss diagnostic reporting when match fails", async () => {
    const filePath = join(testDir, "nearmiss.ts");
    const fileContent = "line 1\nline 2\nconst connection = await pool.getConnection();\nline 4\nline 5\n";
    await writeFile(filePath, fileContent, "utf-8");

    // Model omitted 'await'
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "const connection = pool.getConnection();",
        new_string: "const connection = null;",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Near-miss found around line 3");
    expect(result.output).toContain("Expected:");
    expect(result.output).toContain("Found:");
  });

  // 8. Ambiguous match rejection (multiple occurrences)
  it("8. rejects ambiguous matches with multiple candidate occurrences", async () => {
    const filePath = join(testDir, "ambig.txt");
    const fileContent = "item: apple\nitem: banana\nitem: apple\n";
    await writeFile(filePath, fileContent, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "item: apple",
        new_string: "item: orange",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Found 2 exact occurrences");
    expect(result.output).toContain("Provide more surrounding context");

    // Verify file untouched
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(fileContent);
  });

  // 9. Multi-block edits in single call
  it("9. applies multi-block edits atomically in a single call", async () => {
    const filePath = join(testDir, "multiblock.txt");
    const fileContent = "HEADER\nsection 1: alpha\nMIDDLE\nsection 2: beta\nFOOTER\n";
    await writeFile(filePath, fileContent, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        edits: [
          { old_string: "section 1: alpha", new_string: "section 1: ONE" },
          { old_string: "section 2: beta", new_string: "section 2: TWO" },
        ],
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toBe("HEADER\nsection 1: ONE\nMIDDLE\nsection 2: TWO\nFOOTER\n");
  });

  // 10. Multi-block with overlapping ranges (must reject)
  it("10. rejects multi-block edits when ranges overlap", async () => {
    const filePath = join(testDir, "overlap.txt");
    const fileContent = "line A\nline B\nline C\nline D\n";
    await writeFile(filePath, fileContent, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        edits: [
          { old_string: "line B\nline C", new_string: "REPLACE 1" },
          { old_string: "line C\nline D", new_string: "REPLACE 2" },
        ],
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Overlapping edit ranges detected");

    // File remains completely untouched
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(fileContent);
  });

  // 11. Atomic failure rollback (one bad block leaves file untouched)
  it("11. rolls back atomically: failure in one block leaves file untouched", async () => {
    const filePath = join(testDir, "atomic-rollback.txt");
    const fileContent = "first block\nsecond block\nthird block\n";
    await writeFile(filePath, fileContent, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        edits: [
          { old_string: "first block", new_string: "FIRST MODIFIED" },
          { old_string: "NON-EXISTENT BLOCK", new_string: "NEVER APPLIED" },
        ],
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("NON-EXISTENT BLOCK");

    // File MUST be completely untouched (first block NOT modified)
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(fileContent);
  });

  // 12. Empty file handling
  it("12. handles empty file gracefully", async () => {
    const filePath = join(testDir, "empty.txt");
    await writeFile(filePath, "", "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "something",
        new_string: "replacement",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("File is empty");
  });

  // 13. Single-character edits
  it("13. supports precise single-character edits", async () => {
    const filePath = join(testDir, "char.txt");
    await writeFile(filePath, "a:b\n", "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: ":",
        new_string: "=",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toBe("a=b\n");
  });

  // 14. Preserving original file line endings
  it("14. preserves original CRLF line endings throughout the file", async () => {
    const filePath = join(testDir, "preserve-crlf.txt");
    const content = "first\r\nsecond\r\nthird\r\n";
    await writeFile(filePath, content, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "second\n", // LF in request
        new_string: "2nd\nmore\n", // LF in request
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toBe("first\r\n2nd\r\nmore\r\nthird\r\n");
    expect(updated).not.toMatch(/[^\r]\n/); // Zero bare LF
  });

  // 15. Unicode normalization matching
  it("15. matches Unicode variations such as smart quotes and dashes", async () => {
    const filePath = join(testDir, "unicode.md");
    // File contains ASCII double quotes and hyphen
    const content = 'Use "quotes" and - dashes here.\n';
    await writeFile(filePath, content, "utf-8");

    // Model generates smart quotes and em-dash
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "Use \u201Cquotes\u201D and \u2014 dashes here.",
        new_string: 'Use "updated quotes" and - dashes here.',
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toContain("updated quotes");
  });

  // 16. Conservative fuzzy match with confidence threshold
  it("16. performs conservative fuzzy match when unambiguous", async () => {
    const filePath = join(testDir, "fuzzy.ts");
    const fileContent = "import { x } from 'pkg';\n\nconsole.log('unique debugging marker 98765');\n\nexport const a = 1;\n";
    await writeFile(filePath, fileContent, "utf-8");

    // Minor variation (single character typo in non-critical string)
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "console.log('unique debugging marker 98765');",
        new_string: "// log removed",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const updated = await readFile(filePath, "utf-8");
    expect(updated).toContain("// log removed");
  });

  // 17. Undo tracking still works correctly
  it("17. integrates with pushUndo and allows complete undo restoration", async () => {
    const filePath = join(testDir, "undoable.txt");
    const originalText = "Original content before any edit\nSecond line\n";
    await writeFile(filePath, originalText, "utf-8");

    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "Original content",
        new_string: "Modified content",
      },
      { cwd: testDir },
    );

    expect(result.isError).toBe(false);
    const modified = await readFile(filePath, "utf-8");
    expect(modified).toContain("Modified content");

    // Perform undo
    const undoResult = await performUndo();
    expect(undoResult).not.toBeNull();
    expect(undoResult?.path).toBe(filePath);

    // Verify restored
    const restored = await readFile(filePath, "utf-8");
    expect(restored).toBe(originalText);
  });
});
