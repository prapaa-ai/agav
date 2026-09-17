import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import { fileReadTool } from "../tools/file-read.js";
import { fileWriteTool } from "../tools/file-write.js";
import { editFileTool } from "../tools/file-edit.js";
import { listDirectoryTool } from "../tools/list-directory.js";
import { findFilesTool } from "../tools/find-files.js";
import { grepSearchTool } from "../tools/grep-search.js";
import { shellTool } from "../tools/shell.js";
import { createSubagentTool } from "../tools/subagent.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";
import type { LLMProvider } from "../providers/types.js";

describe("Subagent Path-Scoped CWD Isolation (P0.1)", () => {
  let rootTestDir: string;
  let worktree1: string;
  let worktree2: string;
  let worktree3: string;
  let parentCwd: string;

  beforeEach(async () => {
    parentCwd = process.cwd();
    rootTestDir = await mkdtemp(join(tmpdir(), "agav-cwd-iso-"));
    worktree1 = join(rootTestDir, "wt-1");
    worktree2 = join(rootTestDir, "wt-2");
    worktree3 = join(rootTestDir, "wt-3");

    await mkdir(worktree1, { recursive: true });
    await mkdir(worktree2, { recursive: true });
    await mkdir(worktree3, { recursive: true });

    // Seed distinct initial files with relative path "config.txt" in each worktree
    await writeFile(join(worktree1, "config.txt"), "wt-1-initial", "utf-8");
    await writeFile(join(worktree2, "config.txt"), "wt-2-initial", "utf-8");
    await writeFile(join(worktree3, "config.txt"), "wt-3-initial", "utf-8");
  });

  afterEach(async () => {
    // Ensure parent process cwd was never mutated
    expect(process.cwd()).toBe(parentCwd);
    await rm(rootTestDir, { recursive: true, force: true }).catch(() => {});
  });

  it("executes concurrent child operations across 3 worktrees with zero cross-contamination and without mutating parent cwd", async () => {
    const chdirSpy = vi.spyOn(process, "chdir");

    // Setup 3 child registries scoped to worktree1, worktree2, and worktree3
    const reg1 = new ToolRegistry({ cwd: worktree1 });
    reg1.register(fileReadTool);
    reg1.register(fileWriteTool);
    reg1.register(editFileTool);

    const reg2 = new ToolRegistry({ cwd: worktree2 });
    reg2.register(fileReadTool);
    reg2.register(fileWriteTool);
    reg2.register(editFileTool);

    const reg3 = new ToolRegistry({ cwd: worktree3 });
    reg3.register(fileReadTool);
    reg3.register(fileWriteTool);
    reg3.register(editFileTool);

    // Execute concurrent writes and edits using RELATIVE paths "data.txt" and "config.txt"
    await Promise.all([
      (async () => {
        await reg1.execute("write_file", { path: "data.txt", content: "payload-1" });
        await reg1.execute("edit_file", { path: "config.txt", old_string: "wt-1-initial", new_string: "wt-1-modified" });
        const res = await reg1.execute("read_file", { path: "data.txt" });
        expect(res.output).toContain("payload-1");
      })(),
      (async () => {
        await reg2.execute("write_file", { path: "data.txt", content: "payload-2" });
        await reg2.execute("edit_file", { path: "config.txt", old_string: "wt-2-initial", new_string: "wt-2-modified" });
        const res = await reg2.execute("read_file", { path: "data.txt" });
        expect(res.output).toContain("payload-2");
      })(),
      (async () => {
        await reg3.execute("write_file", { path: "data.txt", content: "payload-3" });
        await reg3.execute("edit_file", { path: "config.txt", old_string: "wt-3-initial", new_string: "wt-3-modified" });
        const res = await reg3.execute("read_file", { path: "data.txt" });
        expect(res.output).toContain("payload-3");
      })(),
    ]);

    // Verify files on disk remained strictly inside their respective worktrees
    expect(await readFile(join(worktree1, "data.txt"), "utf-8")).toBe("payload-1");
    expect(await readFile(join(worktree2, "data.txt"), "utf-8")).toBe("payload-2");
    expect(await readFile(join(worktree3, "data.txt"), "utf-8")).toBe("payload-3");

    expect(await readFile(join(worktree1, "config.txt"), "utf-8")).toBe("wt-1-modified");
    expect(await readFile(join(worktree2, "config.txt"), "utf-8")).toBe("wt-2-modified");
    expect(await readFile(join(worktree3, "config.txt"), "utf-8")).toBe("wt-3-modified");

    // Verify parent cwd was never altered
    expect(process.cwd()).toBe(parentCwd);

    // Verify process.chdir was never called
    expect(chdirSpy).not.toHaveBeenCalled();
    chdirSpy.mockRestore();
  });

  it("nested subagent contexts inherit the correct scoped cwd", async () => {
    // Grandparent registry
    const parentRegistry = new ToolRegistry({ cwd: worktree1 });
    parentRegistry.register(fileReadTool);
    parentRegistry.register(fileWriteTool);

    // Child registry inheriting parent cwd
    const childCwd = parentRegistry.getDefaultContext()?.cwd ?? process.cwd();
    const childRegistry = new ToolRegistry({ cwd: childCwd });
    childRegistry.register(fileReadTool);
    childRegistry.register(fileWriteTool);

    // Grandchild registry inheriting child cwd
    const grandchildCwd = childRegistry.getDefaultContext()?.cwd ?? process.cwd();
    const grandchildRegistry = new ToolRegistry({ cwd: grandchildCwd });
    grandchildRegistry.register(fileReadTool);
    grandchildRegistry.register(fileWriteTool);

    expect(grandchildRegistry.getDefaultContext()?.cwd).toBe(worktree1);

    await grandchildRegistry.execute("write_file", { path: "nested.txt", content: "nested-content" });
    expect(await readFile(join(worktree1, "nested.txt"), "utf-8")).toBe("nested-content");
    expect(process.cwd()).toBe(parentCwd);
  });

  it("relative paths without execution context default safely to process.cwd()", async () => {
    const defaultRegistry = new ToolRegistry(); // No defaultContext
    defaultRegistry.register(fileWriteTool);
    defaultRegistry.register(fileReadTool);

    const tempFileName = `agav-temp-${Date.now()}.txt`;
    try {
      await defaultRegistry.execute("write_file", { path: tempFileName, content: "default-cwd-content" });
      const readRes = await defaultRegistry.execute("read_file", { path: tempFileName });
      expect(readRes.output).toContain("default-cwd-content");

      // File should exist at process.cwd() / tempFileName
      expect(await readFile(resolve(parentCwd, tempFileName), "utf-8")).toBe("default-cwd-content");
    } finally {
      await rm(resolve(parentCwd, tempFileName), { force: true }).catch(() => {});
    }
  });

  it("absolute paths continue working normally regardless of context cwd", async () => {
    const scopedRegistry = new ToolRegistry({ cwd: worktree1 });
    scopedRegistry.register(fileWriteTool);
    scopedRegistry.register(fileReadTool);

    const absoluteTargetPath = join(worktree2, "absolute-target.txt");
    await scopedRegistry.execute("write_file", { path: absoluteTargetPath, content: "written-by-wt1-to-wt2" });

    // File should be created in worktree2 because an absolute path was specified
    expect(await readFile(absoluteTargetPath, "utf-8")).toBe("written-by-wt1-to-wt2");
  });

  it("list_directory, find_files, and grep_search resolve relative paths against scoped cwd", async () => {
    const scopedRegistry = new ToolRegistry({ cwd: worktree1 });
    scopedRegistry.register(listDirectoryTool);
    scopedRegistry.register(findFilesTool);
    scopedRegistry.register(grepSearchTool);

    await writeFile(join(worktree1, "sample.ts"), "export const ALPHA = 42;", "utf-8");

    // list_directory with relative default "."
    const listRes = await scopedRegistry.execute("list_directory", {});
    expect(listRes.output).toContain("sample.ts");

    // find_files with relative search
    const findRes = await scopedRegistry.execute("find_files", { pattern: "*.ts" });
    expect(findRes.output).toContain("sample.ts");

    // grep_search with relative search
    const grepRes = await scopedRegistry.execute("grep_search", { pattern: "ALPHA" });
    expect(grepRes.output).toContain("sample.ts");
    expect(grepRes.output).toContain("ALPHA");
  });

  it("shell tool executes inside the scoped cwd", async () => {
    const scopedRegistry = new ToolRegistry({ cwd: worktree1 });
    scopedRegistry.register(shellTool);

    // Print working directory via shell tool
    const cmd = process.platform === "win32" ? "cd" : "pwd";
    const res = await scopedRegistry.execute("run_command", { command: cmd });

    // Output should contain worktree1 directory path
    const normalizedOutput = res.output.replace(/\\/g, "/").toLowerCase();
    const normalizedExpected = worktree1.replace(/\\/g, "/").toLowerCase();
    expect(normalizedOutput).toContain(normalizedExpected);

    // Parent process.cwd() must remain unchanged
    expect(process.cwd()).toBe(parentCwd);
  });

  it("subagent tool creates childRegistry with scoped cwd and never calls process.chdir", async () => {
    const chdirSpy = vi.spyOn(process, "chdir");

    let subagentChildProgress = false;
    const mockProvider: LLMProvider = {
      name: "mock",
      async *stream() {
        // Mock simple completion without tools
        yield { type: "text_delta" as const, text: "Task finished." };
        yield { type: "message_end" as const, stopReason: "end_turn" };
      },
    };

    const parentRegistry = new ToolRegistry({ cwd: worktree1 });
    parentRegistry.register(fileReadTool);
    parentRegistry.register(fileWriteTool);

    const confirmationQueue = new ConfirmationQueue();

    const subagentTool = createSubagentTool({
      provider: mockProvider,
      parentToolRegistry: parentRegistry,
      getConfig: () => ({
        model: "mock-model",
        systemPrompt: "test",
        permissionMode: "auto-accept",
        effort: "low",
        maxIterations: 5,
      }),
      confirmationQueue,
      onProgressUpdate: () => { subagentChildProgress = true; },
      onTokenUsage: () => {},
      getSignal: () => undefined,
    });

    const result = await subagentTool.execute({
      title: "Inspect task",
      task: "Inspect configuration files",
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Task finished.");
    expect(subagentChildProgress).toBe(true);

    // Confirm that process.chdir was NEVER invoked during subagent lifecycle
    expect(chdirSpy).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(parentCwd);

    chdirSpy.mockRestore();
  });
});