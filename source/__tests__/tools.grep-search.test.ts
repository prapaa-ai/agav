import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

import { platform } from "node:os";
import { execFile } from "node:child_process";
import { grepSearchTool } from "../tools/grep-search.js";

const excludedDirectories = ["node_modules", ".git", "build", "dist", ".next", ".venv", "__pycache__", "coverage"];
let directory: string;
const originalDirectory = process.cwd();
let nativeAvailable = process.platform !== "win32";
if (nativeAvailable) {
  try { execFileSync("grep", ["--version"]); } catch { nativeAvailable = false; }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agav-grep-test-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  process.chdir(originalDirectory);
  vi.mocked(platform).mockReset();
  await rm(directory, { recursive: true, force: true });
});
async function file(name: string, content = "needle\n") {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe("grep_search native output", () => {
  beforeEach(() => {
    vi.mocked(platform).mockReturnValue("linux");
  });

  it("requests filenames even for a single explicit file", async () => {
    const target = await file("single.ts");
    vi.mocked(execFile).mockImplementationOnce(((_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const output = args.includes("-H") ? `${target}:1:needle\n` : "1:needle\n";
      callback(null, output, "");
    }) as typeof execFile);
    expect(await grepSearchTool.execute({ pattern: "needle", path: target })).toEqual({
      output: `${target}:1:needle`, isError: false,
    });
  });

  it.each([
    ["CR", "\r"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ])("preserves %s inside content while normalizing only LF record starts", async (_name, separator) => {
    await file("build/visible.ts");
    const root = join(directory, "build");
    const content = `needle${separator}./literal${separator}Binary file ./literal matches`;
    const records = [
      `./visible.ts:1:${content}`,
      "Binary file ./nested/gnu.bin matches",
      `./visible.ts:2:${content}`,
      "./nested/bsd.bin: binary file matches",
      `./other.ts:3:${content}`,
    ];
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, records.join("\n") + "\n", "");
    }) as typeof execFile);
    expect(await grepSearchTool.execute({ pattern: "needle", path: root })).toEqual({
      output: [
        `${root}/visible.ts:1:${content}`,
        `Binary file ${root}/nested/gnu.bin matches`,
        `${root}/visible.ts:2:${content}`,
        `${root}/nested/bsd.bin: binary file matches`,
        `${root}/other.ts:3:${content}`,
      ].join("\n"),
      isError: false,
    });
  });

  it.each(["Binary file ./nested/file.bin matches", "./nested/file.bin: binary file matches"])(
    "normalizes binary paths without rewriting matching text: %s", async (binaryOutput) => {
      await file("build/nested/file.bin", "needle\0\n");
      const root = join(directory, "build");
      const textOutput = "./visible.ts:1:Binary file ./literal matches";
      vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, `${binaryOutput}\n${textOutput}\n`, "");
      }) as typeof execFile);
      expect(await grepSearchTool.execute({ pattern: "needle", path: root })).toEqual({
        output: `${binaryOutput.replace("./", `${root}/`)}\n${root}/visible.ts:1:Binary file ./literal matches`,
        isError: false,
      });
    },
  );
});

for (const backend of ["native", "fallback"] as const) {
  describe.skipIf(backend === "native" && !nativeAvailable)(`grep_search ${backend}`, () => {
    beforeEach(() => {
      vi.mocked(platform).mockReturnValue(backend === "fallback" ? "win32" : "darwin");
    });
    afterEach(() => {
      if (backend === "fallback") expect(execFile).not.toHaveBeenCalled();
      else expect(execFile).toHaveBeenCalled();
    });

    it("skips all excluded directories recursively, including with a default root", async () => {
      const visible = await file("src/visible.ts");
      for (const excluded of excludedDirectories) {
        await file(`${excluded}/noise.ts`);
        await file(`src/${excluded}/noise.ts`);
      }
      const expected = { output: `${visible}:1:needle`, isError: false };
      expect(await grepSearchTool.execute({ pattern: "needle", path: directory })).toEqual(expected);
      process.chdir(directory);
      expect(await grepSearchTool.execute({ pattern: "needle" })).toEqual({
        output: `${join(process.cwd(), "src/visible.ts")}:1:needle`, isError: false,
      });
    });

    it("does not let noisy excluded matches crowd relevant capped results", async () => {
      for (const excluded of excludedDirectories) {
        await file(`${excluded}/noise.ts`, "needle noise\n".repeat(120));
      }
      const visible = await file("src/visible.ts", "needle relevant\n".repeat(105));
      const result = await grepSearchTool.execute({ pattern: "needle", path: directory });
      expect(result.isError).toBe(false);
      const lines = result.output.split("\n");
      expect(lines.slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => `${visible}:${i + 1}:needle relevant`));
      expect(lines[100]).toBe(backend === "native" ? "... 5 more matches" : "... results truncated at 100 matches");
      expect(lines).toHaveLength(101);
    });

    it.each(excludedDirectories)("searches explicit %s roots, files and nested paths", async (excluded) => {
      const direct = await file(`${excluded}/generated.ts`);
      const nested = await file(`${excluded}/inner/nested.ts`);
      await file(`${excluded}/inner/build/skipped.ts`);
      await file(`${excluded}/coverage/skipped.ts`);
      const rootResult = await grepSearchTool.execute({ pattern: "needle", path: join(directory, excluded), include: "*.ts" });
      expect(rootResult.isError).toBe(false);
      expect(rootResult.output.split("\n").sort()).toEqual([`${direct}:1:needle`, `${nested}:1:needle`].sort());
      expect(await grepSearchTool.execute({ pattern: "needle", path: direct })).toEqual({ output: `${direct}:1:needle`, isError: false });
      expect(await grepSearchTool.execute({ pattern: "needle", path: join(directory, excluded, "inner") })).toEqual({ output: `${nested}:1:needle`, isError: false });
      expect(await grepSearchTool.execute({ pattern: "needle", path: nested })).toEqual({ output: `${nested}:1:needle`, isError: false });
      const deeplyExcluded = await file(`${excluded}/inner/build/target.ts`);
      const deepResult = await grepSearchTool.execute({ pattern: "needle", path: join(directory, excluded, "inner", "build") });
      expect(deepResult.isError).toBe(false);
      expect(deepResult.output).toContain(`${deeplyExcluded}:1:needle`);
      expect(await grepSearchTool.execute({ pattern: "needle", path: deeplyExcluded })).toEqual({ output: `${deeplyExcluded}:1:needle`, isError: false });
    });

    it("preserves include filtering, regex matching, line numbers and no-match output", async () => {
      const visible = await file("src/visible.ts", "ignore\nneedle42\nneedleX\n");
      await file("src/notes.txt", "needle42\n");
      expect(await grepSearchTool.execute({ pattern: "^needle[0-9]+$", path: directory, include: "*.ts" })).toEqual({ output: `${visible}:2:needle42`, isError: false });
      expect(await grepSearchTool.execute({ pattern: "absent", path: directory })).toEqual({ output: "No matches found.", isError: false });
      expect(await grepSearchTool.execute({ pattern: "needle", path: visible, include: "*.py" })).toEqual({ output: "No matches found.", isError: false });
      const namedLikeDirectory = await file("build", "needle\n");
      expect(await grepSearchTool.execute({ pattern: "needle", path: namedLikeDirectory })).toEqual({ output: `${namedLikeDirectory}:1:needle`, isError: false });
    });
  });
}
