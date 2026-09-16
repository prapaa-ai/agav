import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFilesTool } from "../tools/find-files.js";

describe("findFilesTool", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = null;
    }
  });

  it("finds matching files when count is below MAX_RESULTS", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "find-files-test-"));
    await writeFile(join(tempDir, "a.txt"), "hello");
    await writeFile(join(tempDir, "b.txt"), "world");
    await writeFile(join(tempDir, "c.log"), "log");

    const result = await findFilesTool.execute({ pattern: "*.txt", path: tempDir });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("a.txt");
    expect(result.output).toContain("b.txt");
    expect(result.output).not.toContain("c.log");
    expect(result.output).not.toContain("results truncated");
  });

  it("returns 'No files found.' when nothing matches", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "find-files-test-"));
    await writeFile(join(tempDir, "a.txt"), "hello");

    const result = await findFilesTool.execute({ pattern: "*.md", path: tempDir });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("No files found.");
  });

  it("does not report truncation when matching count is exactly MAX_RESULTS (200)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "find-files-test-"));
    for (let i = 0; i < 200; i++) {
      await writeFile(join(tempDir, `file_${String(i).padStart(3, "0")}.txt`), "");
    }

    const result = await findFilesTool.execute({ pattern: "*.txt", path: tempDir });
    expect(result.isError).toBe(false);
    const lines = result.output.split("\n");
    expect(lines.length).toBe(200);
    expect(result.output).not.toContain("results truncated");
  });

  it("reports truncation when matching count exceeds MAX_RESULTS (200)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "find-files-test-"));
    for (let i = 0; i < 205; i++) {
      await writeFile(join(tempDir, `file_${String(i).padStart(3, "0")}.txt`), "");
    }

    const result = await findFilesTool.execute({ pattern: "*.txt", path: tempDir });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("... results truncated at 200 files");
    const lines = result.output.split("\n");
    expect(lines.length).toBe(201);
  });

  it("skips directories in SKIP_DIRS (e.g. node_modules, .git)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "find-files-test-"));
    const nmDir = join(tempDir, "node_modules");
    await mkdir(nmDir);
    await writeFile(join(nmDir, "ignored.txt"), "skip me");
    await writeFile(join(tempDir, "kept.txt"), "keep me");

    const result = await findFilesTool.execute({ pattern: "*.txt", path: tempDir });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("kept.txt");
    expect(result.output).not.toContain("ignored.txt");
  });
});
