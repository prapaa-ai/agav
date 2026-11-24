import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/sandbox.js", async original => ({
  ...await original<typeof import("../utils/sandbox.js")>(),
  runInSandbox: vi.fn(),
  detectSandboxBackend: vi.fn(() => "none"),
  getAvailableSandboxOverrides: vi.fn(() => []),
}));
import { runInSandbox } from "../utils/sandbox.js";
import { shellTool } from "../tools/shell.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runInSandbox).mockResolvedValue({ stdout: "", stderr: "", error: null, backend: "none" });
});
afterEach(() => vi.restoreAllMocks());

describe("run_command cwd", () => {
  it("runs in the current directory when cwd is omitted", async () => {
    await shellTool.execute({ command: "echo harmless" });
    expect(runInSandbox).toHaveBeenCalledWith(expect.objectContaining({ cwd: process.cwd() }));
  });

  it("resolves a relative path and runs there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-cwd-"));
    try {
      const relative = join(dir, "..", dir.split("/").pop()!);
      await shellTool.execute({ command: "echo harmless", cwd: relative });
      expect(runInSandbox).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing directory without running", async () => {
    const result = await shellTool.execute({ command: "echo harmless", cwd: "/definitely/not/a/dir" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/does not exist or cannot be read/);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it("rejects a file and an empty value without running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agav-cwd-file-"));
    const file = join(dir, "note.txt");
    await writeFile(file, "x");
    try {
      const asFile = await shellTool.execute({ command: "echo harmless", cwd: file });
      expect(asFile.isError).toBe(true);
      expect(asFile.output).toMatch(/is not a directory/);
      const empty = await shellTool.execute({ command: "echo harmless", cwd: "  " });
      expect(empty.isError).toBe(true);
      expect(empty.output).toMatch(/non-empty directory path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(runInSandbox).not.toHaveBeenCalled();
  });
});
