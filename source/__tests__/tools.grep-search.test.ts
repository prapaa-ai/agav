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

  it.each(["file", "directory", "excluded root"])("separates option-like patterns from options for an explicit %s", async (kind) => {
    const target = await file(kind === "excluded root" ? "build/visible.ts" : "src/visible.ts", "--help\n");
    const searchPath = kind === "file" ? target : dirname(target);
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    }) as typeof execFile);
    await grepSearchTool.execute({ pattern: "--help", path: searchPath, include: "*.ts" });
    expect(execFile).toHaveBeenCalledWith("grep", [
      "-rn", "-H", "--color=never", "-E", "--include", "*.ts",
      ...excludedDirectories.map((dir) => `--exclude-dir=${dir}`),
      "-e", "--help", "--", kind === "excluded root" ? "." : searchPath,
    ], { maxBuffer: 200_000, timeout: 15_000, cwd: kind === "excluded root" ? searchPath : undefined }, expect.any(Function));
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

    it.each(["--help", "-n", "--directories", "--directories=skip", "-", "--help|--directories"])("searches leading-dash regex %s as content in files and directories", async (pattern) => {
      const content = "ignore\n--help -n --directories=skip\n";
      const visible = await file("src/visible.ts", content);
      const generated = await file("build/visible.ts", content);
      await file("src/notes.txt", content);
      await file("build/notes.txt", content);
      await file("src/dist/noise.ts", content);
      await file("build/dist/noise.ts", content);
      for (const path of [visible, dirname(visible), generated, dirname(generated)]) {
        const expectedPath = path === generated || path === dirname(generated) ? generated : visible;
        expect(await grepSearchTool.execute({ pattern, path, include: "*.ts" })).toEqual({
          output: `${expectedPath}:2:--help -n --directories=skip`, isError: false,
        });
      }
      process.chdir(dirname(visible));
      expect(await grepSearchTool.execute({ pattern, include: "*.ts" })).toEqual({
        output: `${join(process.cwd(), "visible.ts")}:2:--help -n --directories=skip`, isError: false,
      });
    });

    it.each(["--help", "-n", "--directories", "--directories=skip", "-"])("returns no matches for absent leading-dash pattern %s", async (pattern) => {
      const visible = await file("src/visible.ts", "ordinary content\n");
      const generated = await file("build/visible.ts", "ordinary content\n");
      for (const path of [visible, dirname(visible), generated, dirname(generated)]) {
        expect(await grepSearchTool.execute({ pattern, path })).toEqual({ output: "No matches found.", isError: false });
      }
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

    it("returns each matching file once without its content", async () => {
      const first = await file("src/first.ts", "needle42\nneedle43\n".repeat(150));
      const second = await file("src/second.ts", "needle44\n");
      await file("src/notes.txt");
      await file("dist/noise.ts");
      await file("src/binary.ts", "needle42\0");
      const result = await grepSearchTool.execute({ pattern: "^needle[0-9]+", path: directory, include: "*.ts", files_only: true });
      expect(result.isError).toBe(false);
      expect(result.output.split("\n").sort()).toEqual([first, second].sort());
      expect(await grepSearchTool.execute({ pattern: "needle", path: first, files_only: true })).toEqual({ output: first, isError: false });
      expect(await grepSearchTool.execute({ pattern: "absent", path: directory, files_only: true })).toEqual({ output: "No matches found.", isError: false });
    });

    it("normalizes explicit excluded roots in files-only mode", async () => {
      const target = await file("build/visible.ts", "--help\n--help\n");
      await file("build/dist/noise.ts", "--help\n");
      expect(await grepSearchTool.execute({ pattern: "--help", path: dirname(target), files_only: true })).toEqual({ output: target, isError: false });
    });

    it("caps files, not matches, and only reports truncation when additional files exist", async () => {
      for (let i = 0; i < 100; i++) await file(`src/${String(i).padStart(3, "0")}.ts`, "needle\nneedle\n");
      const exact = await grepSearchTool.execute({ pattern: "needle", path: directory, files_only: true });
      expect(exact.output.split("\n")).toHaveLength(100);
      expect(exact.output).not.toContain("truncated");
      await file("src/extra.ts");
      const capped = await grepSearchTool.execute({ pattern: "needle", path: directory, files_only: true });
      expect(capped.output.split("\n")).toHaveLength(101);
      expect(capped.output.split("\n").at(-1)).toBe("... results truncated at 100 files");
    });

    it("reports missing roots and invalid regexes as errors, not no matches", async () => {
      const missing = await grepSearchTool.execute({ pattern: "needle", path: join(directory, "missing"), files_only: true });
      expect(missing.isError).toBe(true);
      const invalid = await grepSearchTool.execute({ pattern: "[", path: directory, files_only: true });
      expect(invalid.isError).toBe(true);
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

describe("files-only validation and partial search failures", () => {
  it.each([null, "true", 1, {}])("rejects malformed files_only: %s", async value => {
    const result = await grepSearchTool.execute({ pattern: "needle", path: directory, files_only: value });
    expect(result.isError).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back when grep is unavailable and preserves the default line mode", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const target = await file("fixture.ts", "needle\nneedle\n");
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(Object.assign(new Error("grep unavailable"), { code: "ENOENT" }), "", "");
    }) as typeof execFile);
    expect(await grepSearchTool.execute({ pattern: "needle", path: target, files_only: true })).toEqual({ output: target, isError: false });
    vi.mocked(platform).mockReturnValue("win32");
    expect(await grepSearchTool.execute({ pattern: "needle", path: target, files_only: false }))
      .toEqual({ output: `${target}:1:needle\n${target}:2:needle`, isError: false });
  });

  it("preserves partial native output but flags incomplete searches", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(Object.assign(new Error("search timed out"), { code: 2 }), `${directory}/found.ts\n`, "grep: permission denied");
    }) as typeof execFile);
    const result = await grepSearchTool.execute({ pattern: "needle", path: directory, files_only: true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("found.ts");
    expect(result.output).toContain("permission denied");
    expect(result.output).toContain("incomplete");
  });
});
