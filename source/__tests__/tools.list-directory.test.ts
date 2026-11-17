import { readdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDirectoryTool } from "../tools/list-directory.js";

vi.mock("node:fs/promises", () => ({ readdir: vi.fn(), stat: vi.fn() }));
const mockRead = vi.mocked(readdir);
const mockStat = vi.mocked(stat);

beforeEach(() => {
  vi.resetAllMocks();
  mockRead.mockResolvedValue(["z-dir", "y-unclassified", "x-other", "w-file", "a-dir-link", ".hidden"] as never);
  mockStat.mockImplementation(async (path) => {
    const name = basename(String(path));
    if (name === "y-unclassified") throw new Error("broken link");
    return {
      isDirectory: () => name === "z-dir" || name === "a-dir-link",
      isFile: () => name === "w-file",
      size: 7,
    } as Awaited<ReturnType<typeof stat>>;
  });
});

describe("list_directory entry type", () => {
  it.each([undefined, "all"])("retains normal output for %s", async (type) => {
    const result = await listDirectoryTool.execute({ type });
    expect(result.output).toBe("a-dir-link/\nw-file  7B\nx-other  7B\ny-unclassified\nz-dir/");
    expect(mockStat.mock.calls.some(([path]) => basename(String(path)) === ".hidden")).toBe(false);
  });

  it("includes only stat-classified regular files in files mode", async () => {
    expect(await listDirectoryTool.execute({ type: "files" })).toEqual({ output: "w-file  7B", isError: false });
  });

  it("includes directories and follows directory symlinks in directories mode", async () => {
    expect(await listDirectoryTool.execute({ type: "directories" })).toEqual({
      output: "a-dir-link/\nz-dir/",
      isError: false,
    });
  });

  it("reports when the selected type has no matches", async () => {
    mockRead.mockResolvedValue(["z-dir"] as never);
    const result = await listDirectoryTool.execute({ type: "files" });
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/no.*files/i);
  });

  it.each(["file", true, null])("rejects %s before reading the directory", async (type) => {
    expect((await listDirectoryTool.execute({ type })).isError).toBe(true);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("preserves directory read errors", async () => {
    mockRead.mockRejectedValue(new Error("permission denied"));
    const result = await listDirectoryTool.execute({ type: "files", path: "missing" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/^Failed to list .*: permission denied$/);
  });
});
