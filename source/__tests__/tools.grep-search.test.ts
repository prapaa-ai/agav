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

it.each([null, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])("rejects invalid max_results %s before invoking grep", async (max_results) => {
  vi.mocked(platform).mockReturnValue("darwin");
  expect(await grepSearchTool.execute({ pattern: "needle", max_results })).toEqual({
    output: "max_results must be a positive safe integer",
    isError: true,
  });
  expect(execFile).not.toHaveBeenCalled();
});

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

  it.each([
    ["line", ["-rn", "-H", "--color=never", "-E", "-i"]],
    ["files-only", ["-rl", "-I", "--color=never", "-E", "-i"]],
  ])("passes grep -i in %s mode when ignore_case is true", async (mode, flags) => {
    const target = await file("src/visible.ts", "Needle\n");
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    }) as typeof execFile);
    await grepSearchTool.execute({ pattern: "needle", path: target, ignore_case: true, files_only: mode === "files-only" });
    expect(execFile).toHaveBeenCalledWith("grep", [
      ...flags,
      ...excludedDirectories.map((dir) => `--exclude-dir=${dir}`),
      "-e", "needle", "--", target,
    ], { maxBuffer: 200_000, timeout: 15_000, cwd: undefined }, expect.any(Function));
  });

  it("succeeds when native grep fills its buffer after the requested limit", async () => {
    const line = `${directory}/one.ts:1:needle`;
    const stdout = (line + "\n").repeat(Math.floor(200_000 / (line.length + 1))) + "partial";
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
      callback(Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), stdout, "");
    }) as typeof execFile);
    const result = await grepSearchTool.execute({ pattern: "needle", path: directory, max_results: 1 });
    expect(result.isError).toBe(false);
    expect(result.output.split("\n")[0]).toBe(line);
    expect(result.output).not.toContain("partial");
  });

  it("labels partial native line output once a limit is explicitly chosen", async () => {
    const line = `${directory}/one.ts:1:needle`;
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
      callback(Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), line + "\npartial path", "");
    }) as typeof execFile);
    expect(await grepSearchTool.execute({ pattern: "needle", path: directory, max_results: 1000 })).toEqual({
      output: line + "\nSearch incomplete: grep failed",
      isError: true,
    });
  });

  it("omits grep -i when ignore_case is false or absent", async () => {
    const target = await file("src/visible.ts", "needle\n");
    for (const ignoreCase of [false, undefined]) {
      vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, `${target}:1:needle\n`, "");
      }) as typeof execFile);
      expect(await grepSearchTool.execute({ pattern: "needle", path: target, ignore_case: ignoreCase }))
        .toEqual({ output: `${target}:1:needle`, isError: false });
      const args = vi.mocked(execFile).mock.calls.at(-1)![1] as string[];
      expect(args).not.toContain("-i");
    }
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

  it("passes context flags with --null only when context is requested", async () => {
    const target = await file("src/visible.ts");
    for (const [context, flags] of [
      [{}, []],
      [{ context_before: 0, context_after: 0 }, []],
      [{ context_before: 2 }, ["-B", "2", "-A", "0", "--null"]],
      [{ context_after: 3 }, ["-B", "0", "-A", "3", "--null"]],
    ] as const) {
      vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, "", "");
      }) as typeof execFile);
      await grepSearchTool.execute({ pattern: "needle", path: target, ...context });
      expect(vi.mocked(execFile).mock.calls.at(-1)![1]).toEqual([
        "-rn", "-H", "--color=never", "-E", ...flags,
        ...excludedDirectories.map((dir) => `--exclude-dir=${dir}`),
        "-e", "needle", "--", target,
      ]);
    }
  });

  it("parses --null context records, rebuilds separators and counts only matches against the limit", async () => {
    const records = [
      "/a-1-b:2:c.ts\u00001-before",
      "/a-1-b:2:c.ts\u00002:needle one",
      "--",
      "/a-1-b:2:c.ts\u00004-gap",
      "/a-1-b:2:c.ts\u00005:needle two",
      "/other.ts\u00001:needle three",
      "Binary file /data.bin matches",
    ];
    for (let i = 0; i < 2; i++) {
      vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, records.join("\n") + "\n", "");
      }) as typeof execFile);
    }
    expect(await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 1 })).toEqual({
      output: [
        "/a-1-b:2:c.ts-1-before",
        "/a-1-b:2:c.ts:2:needle one",
        "--",
        "/a-1-b:2:c.ts-4-gap",
        "/a-1-b:2:c.ts:5:needle two",
        "--",
        "/other.ts:1:needle three",
        "--",
        "Binary file /data.bin matches",
      ].join("\n"),
      isError: false,
    });
    expect((await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 1, max_results: 2 })).output).toBe([
      "/a-1-b:2:c.ts-1-before",
      "/a-1-b:2:c.ts:2:needle one",
      "--",
      "/a-1-b:2:c.ts-4-gap",
      "/a-1-b:2:c.ts:5:needle two",
      "... results truncated at requested limit of 2 matches",
    ].join("\n"));
  });

  it("does not count binary notices against max_results", async () => {
    const records = [
      `Binary file ${directory}/a.bin matches`,
      `${directory}/b.bin: binary file matches`,
      `${directory}/c.ts\u00001:needle`,
      `${directory}/c.ts\u00002-after`,
    ];
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, records.join("\n") + "\n", "");
    }) as typeof execFile);
    expect(await grepSearchTool.execute({ pattern: "needle", path: directory, context_after: 1, max_results: 1 })).toEqual({
      output: [
        `Binary file ${directory}/a.bin matches`,
        "--",
        `${directory}/b.bin: binary file matches`,
        "--",
        `${directory}/c.ts:1:needle`,
        `${directory}/c.ts-2-after`,
      ].join("\n"),
      isError: false,
    });
  });

  it("parses --null paths containing newlines before splitting records", async () => {
    const odd = `${directory}/a\n${directory}/b.ts`;
    const records = [
      `${directory}/first.ts\u00001:needle`,
      "--",
      `Binary file ${directory}/x.bin matches`,
      `${odd}\u00001-before`,
      `${odd}\u00002:needle`,
    ];
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, records.join("\n") + "\n", "");
    }) as typeof execFile);
    expect(await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 1 })).toEqual({
      output: [
        `${directory}/first.ts:1:needle`,
        "--",
        `Binary file ${directory}/x.bin matches`,
        "--",
        `${odd}-1-before`,
        `${odd}:2:needle`,
      ].join("\n"),
      isError: false,
    });
  });

  it("reports remaining matches, not context lines, past the default limit", async () => {
    const records = Array.from({ length: 102 }, (_, i) => [`/f.ts\u0000${2 * i + 1}-context`, `/f.ts\u0000${2 * i + 2}:needle`]).flat();
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, records.join("\n") + "\n", "");
    }) as typeof execFile);
    const lines = (await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 1 })).output.split("\n");
    expect(lines).toHaveLength(201);
    expect(lines.at(-2)).toBe("/f.ts:200:needle");
    expect(lines.at(-1)).toBe("... 2 more matches");
  });
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
      const explicitDefault = await grepSearchTool.execute({ pattern: "needle", path: directory, max_results: 100 });
      expect(explicitDefault.output.split("\n").at(-1)).toBe("... results truncated at requested limit of 100 matches");
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

    it("limits matching lines or file paths and does not flag an exact count", async () => {
      const first = await file("limit/one.ts", "needle\nneedle\n");
      const second = await file("limit/two.ts", "needle\n");
      const args = { pattern: "needle", path: directory, include: "*.ts" };
      const lines = await grepSearchTool.execute({ ...args, max_results: 2 });
      expect(lines.isError).toBe(false);
      expect(lines.output.split("\n")).toHaveLength(3);
      expect(lines.output.split("\n").at(-1)).toBe("... results truncated at requested limit of 2 matches");

      const files = await grepSearchTool.execute({ ...args, max_results: 1, files_only: true });
      const paths = files.output.split("\n");
      expect(files.isError).toBe(false);
      expect(paths).toHaveLength(2);
      expect([first, second]).toContain(paths[0]);
      expect(paths.at(-1)).toBe("... results truncated at requested limit of 1 file");
      const exact = await grepSearchTool.execute({ ...args, max_results: 2, files_only: true });
      expect(exact.output.split("\n").sort()).toEqual([first, second].sort());
      const exactLines = await grepSearchTool.execute({ ...args, max_results: 3 });
      expect(exactLines.output.split("\n")).toHaveLength(3);
      expect(exactLines.output).not.toContain("truncated");
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

    it("matches case-insensitively only when ignore_case is true and preserves original capitalization", async () => {
      const visible = await file("src/visible.ts", "Needle one\nneedle42\nNEEDLE three\n");
      await file("src/notes.txt", "Needle in txt\n");
      const mixedCase = [
        `${visible}:1:Needle one`,
        `${visible}:2:needle42`,
        `${visible}:3:NEEDLE three`,
      ].join("\n");
      expect(await grepSearchTool.execute({ pattern: "needle", path: directory, include: "*.ts", ignore_case: true })).toEqual({ output: mixedCase, isError: false });
      expect(await grepSearchTool.execute({ pattern: "NEEDLE", path: directory, include: "*.ts", ignore_case: true })).toEqual({ output: mixedCase, isError: false });
      const sensitiveOnly = { output: `${visible}:2:needle42`, isError: false };
      expect(await grepSearchTool.execute({ pattern: "needle", path: directory, include: "*.ts", ignore_case: false })).toEqual(sensitiveOnly);
      expect(await grepSearchTool.execute({ pattern: "needle", path: directory, include: "*.ts" })).toEqual(sensitiveOnly);
      expect(await grepSearchTool.execute({ pattern: "Needle", path: directory, include: "*.ts" })).toEqual({ output: `${visible}:1:Needle one`, isError: false });
    });

    it("applies ignore_case to regex patterns and repeated matches while include still filters filenames", async () => {
      const visible = await file("src/visible.ts", "NEEDLE43\nignore\nNeedle44\nNEEDLE44\n");
      await file("src/notes.txt", "NEEDLE44\n");
      expect(await grepSearchTool.execute({ pattern: "^needle[0-9]+$", path: directory, include: "*.ts", ignore_case: true })).toEqual({
        output: [`${visible}:1:NEEDLE43`, `${visible}:3:Needle44`, `${visible}:4:NEEDLE44`].join("\n"),
        isError: false,
      });
      expect(await grepSearchTool.execute({ pattern: "^needle[0-9]+$", path: directory, include: "*.ts" })).toEqual({
        output: "No matches found.",
        isError: false,
      });
      const includeCase = await grepSearchTool.execute({ pattern: "needle", path: directory, include: "*.ts", ignore_case: true });
      expect(includeCase.isError).toBe(false);
      expect(includeCase.output).not.toContain("notes.txt");
    });

    it("applies exclude by basename after include, before matching content", async () => {
      const kept = await file("src/keep.ts", "needle\n");
      const ignored = await file("src/-generated.ts", "needle\n".repeat(110));
      const upper = await file("src/-UPPER.TS", "NEEDLE\n");
      await file("src/other.py", "needle\n");
      const input = { pattern: "needle", path: directory, include: "*.ts", exclude: "-*.ts" };
      expect(await grepSearchTool.execute(input)).toEqual({ output: kept + ":1:needle", isError: false });
      expect(await grepSearchTool.execute({ ...input, files_only: true })).toEqual({ output: kept, isError: false });
      expect(await grepSearchTool.execute({ ...input, path: ignored })).toEqual({
        output: "No matches found.", isError: false,
      });
      expect(await grepSearchTool.execute({
        pattern: "needle", path: upper, exclude: "-*.ts", ignore_case: true, files_only: true,
      })).toEqual({ output: upper, isError: false });
    });

    it.skipIf(process.platform === "win32")("excludes newline-containing basenames with both wildcards", async () => {
      const kept = await file("src/keep.ts", "needle\n");
      await file("src/a\nb.generated.ts", "needle\n");
      for (const exclude of ["*.generated.ts", "a?b.generated.ts"]) {
        expect(await grepSearchTool.execute({
          pattern: "needle", path: directory, exclude, files_only: true,
        })).toEqual({ output: kept, isError: false });
      }
    });

    it("does not mask an explicitly missing path with exclude in strict mode", async () => {
      const result = await grepSearchTool.execute({
        pattern: "needle", path: join(directory, "-missing.ts"), exclude: "-*.ts", files_only: true,
      });
      expect(result.isError).toBe(true);
    });

    it("combines ignore_case with files_only and keeps line numbers, exclusions and limits", async () => {
      const upper = await file("src/upper.ts", "NEEDLE\n");
      const lower = await file("src/lower.ts", "needle\n");
      await file("build/noise.ts", "Needle noise\n");
      const filesOnlyResult = await grepSearchTool.execute({ pattern: "needle", path: directory, include: "*.ts", ignore_case: true, files_only: true });
      expect(filesOnlyResult.isError).toBe(false);
      expect(filesOnlyResult.output.split("\n").sort()).toEqual([upper, lower].sort());
      expect(await grepSearchTool.execute({ pattern: "needle", path: directory, include: "*.ts", files_only: true })).toEqual({ output: lower, isError: false });
      expect(await grepSearchTool.execute({ pattern: "needle", path: upper, ignore_case: true, files_only: true })).toEqual({ output: upper, isError: false });
      expect(await grepSearchTool.execute({ pattern: "absent", path: directory, ignore_case: true, files_only: true })).toEqual({ output: "No matches found.", isError: false });
      const excludeCheck = await grepSearchTool.execute({ pattern: "noise", path: directory, ignore_case: true, files_only: true });
      expect(excludeCheck.isError).toBe(false);
      expect(excludeCheck.output).not.toContain("build");
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

    describe("context lines", () => {
      const content = "one\ntwo\nneedle A\nthree\nfour\nfive\nsix\nneedle B\nseven\n";

      it("keeps match-only output when context is omitted or zero", async () => {
        const target = await file("src/code.ts", content);
        const expected = { output: `${target}:3:needle A\n${target}:8:needle B`, isError: false };
        expect(await grepSearchTool.execute({ pattern: "needle", path: directory })).toEqual(expected);
        expect(await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 0, context_after: 0 })).toEqual(expected);
      });

      it("includes lines before and after each match with accurate line numbers", async () => {
        const target = await file("src/code.ts", content);
        expect(await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 2, context_after: 1 })).toEqual({
          output: [
            `${target}-1-one`, `${target}-2-two`, `${target}:3:needle A`, `${target}-4-three`,
            "--",
            `${target}-6-five`, `${target}-7-six`, `${target}:8:needle B`, `${target}-9-seven`,
          ].join("\n"),
          isError: false,
        });
        expect(await grepSearchTool.execute({ pattern: "needle B", path: target, context_after: 5 })).toEqual({
          output: `${target}:8:needle B\n${target}-9-seven`, isError: false,
        });
        expect(await grepSearchTool.execute({ pattern: "needle A", path: target, context_before: 5 })).toEqual({
          output: `${target}-1-one\n${target}-2-two\n${target}:3:needle A`, isError: false,
        });
      });

      it("merges overlapping windows without duplicating lines", async () => {
        const target = await file("src/code.ts", "a\nneedle 1\nb\nneedle 2\nc\nd\ne\n");
        expect(await grepSearchTool.execute({ pattern: "needle", path: target, context_before: 2, context_after: 2 })).toEqual({
          output: [`${target}-1-a`, `${target}:2:needle 1`, `${target}-3-b`, `${target}:4:needle 2`, `${target}-5-c`, `${target}-6-d`].join("\n"),
          isError: false,
        });
      });

      it.skipIf(process.platform === "win32")("keeps paths that look like line prefixes intact", async () => {
        const target = await file("src/a-1-b:2:c.ts", "x\nneedle\n");
        expect(await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 1 })).toEqual({
          output: `${target}-1-x\n${target}:2:needle`, isError: false,
        });
      });

      it.skipIf(process.platform === "win32").each(["src", "build"])("keeps file names containing newlines intact under %s", async (root) => {
        const target = await file(`${root}/x\n./y.ts`, "before\nneedle\n");
        expect(await grepSearchTool.execute({ pattern: "needle", path: join(directory, root), context_before: 1 })).toEqual({
          output: `${target}-1-before\n${target}:2:needle`, isError: false,
        });
      });

      it("does not let skipped binary files consume max_results", async () => {
        await file("src/a.bin", "needle\0\n");
        const target = await file("src/z.ts", "needle\nafter\n");
        const result = await grepSearchTool.execute({ pattern: "needle", path: directory, context_after: 1, max_results: 1 });
        expect(result.isError).toBe(false);
        expect(result.output).toContain(`${target}:1:needle\n${target}-2-after`);
        expect(result.output).not.toContain("truncated");
      });

      it("counts matches, not context lines, against max_results", async () => {
        const target = await file("src/code.ts", content);
        expect(await grepSearchTool.execute({ pattern: "needle", path: directory, context_before: 1, context_after: 2, max_results: 1 })).toEqual({
          output: [`${target}-2-two`, `${target}:3:needle A`, `${target}-4-three`, `${target}-5-four`, "... results truncated at requested limit of 1 match"].join("\n"),
          isError: false,
        });
        const exact = await grepSearchTool.execute({ pattern: "needle", path: directory, context_after: 1, max_results: 2 });
        expect(exact.output).not.toContain("truncated");
      });

      it("keeps include, exclude, literal, case and no-match behavior", async () => {
        const target = await file("src/code.ts", "before\nA.B\nafter\n");
        await file("src/skip.ts", "a.b\n");
        await file("src/notes.txt", "a.b\n");
        expect(await grepSearchTool.execute({
          pattern: "a.b", path: directory, include: "*.ts", exclude: "skip*", fixed_strings: true, ignore_case: true, context_before: 1, context_after: 1,
        })).toEqual({ output: `${target}-1-before\n${target}:2:A.B\n${target}-3-after`, isError: false });
        expect(await grepSearchTool.execute({ pattern: "absent", path: directory, context_after: 1 }))
          .toEqual({ output: "No matches found.", isError: false });
      });
    });

    describe("fixed_strings option", () => {
      it("matches a literal string that the regex interpretation would miss", async () => {
        const target = await file("src/code.ts", "items[0].value\n");
        // As regex, [0] is a char-class matching '0', so items[0].value doesn't match items[0].value
        expect(await grepSearchTool.execute({ pattern: "items[0].value", path: target }))
          .toEqual({ output: "No matches found.", isError: false });
        expect(await grepSearchTool.execute({ pattern: "items[0].value", path: target, fixed_strings: true }))
          .toEqual({ output: `${target}:1:items[0].value`, isError: false });
      });

      it("matches a bare unmatched [ that is invalid as a regex", async () => {
        const target = await file("src/code.ts", "arr[ = 1\n");
        expect(await grepSearchTool.execute({ pattern: "[", path: target, fixed_strings: true }))
          .toEqual({ output: `${target}:1:arr[ = 1`, isError: false });
      });

      it("treats . as a literal period rather than any-character", async () => {
        const withPeriod = await file("src/a.ts", "foo.bar\n");
        const withX = await file("src/b.ts", "fooXbar\n");
        expect(await grepSearchTool.execute({ pattern: "foo.bar", path: withX, fixed_strings: true }))
          .toEqual({ output: "No matches found.", isError: false });
        expect(await grepSearchTool.execute({ pattern: "foo.bar", path: withPeriod, fixed_strings: true }))
          .toEqual({ output: `${withPeriod}:1:foo.bar`, isError: false });
      });

      it("works with files_only", async () => {
        const target = await file("src/code.ts", "foo.bar()\n");
        await file("src/other.ts", "fooXbar()\n");
        expect(await grepSearchTool.execute({ pattern: "foo.bar()", path: directory, include: "*.ts", fixed_strings: true, files_only: true }))
          .toEqual({ output: target, isError: false });
      });

      it("empty literal pattern matches every line but not a phantom trailing line", async () => {
        const target = await file("src/code.ts", "line1\nline2\n");
        const result = await grepSearchTool.execute({ pattern: "", path: target, fixed_strings: true });
        expect(result).toEqual({ output: `${target}:1:line1\n${target}:2:line2`, isError: false });
      });

      it("empty literal pattern on an empty file returns no matches", async () => {
        const target = await file("src/empty.ts", "");
        expect(await grepSearchTool.execute({ pattern: "", path: target, fixed_strings: true }))
          .toEqual({ output: "No matches found.", isError: false });
      });

      it("preserves include filtering and line numbers", async () => {
        const ts = await file("src/code.ts", "ignore\nfoo.bar\n");
        await file("src/notes.txt", "foo.bar\n");
        expect(await grepSearchTool.execute({ pattern: "foo.bar", path: directory, include: "*.ts", fixed_strings: true }))
          .toEqual({ output: `${ts}:2:foo.bar`, isError: false });
      });
    });
  });
}

describe("ignore_case validation", () => {
  it.each([null, "true", 1, {}])("rejects malformed ignore_case: %s without searching", async value => {
    const result = await grepSearchTool.execute({ pattern: "needle", path: directory, ignore_case: value });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("ignore_case");
    expect(execFile).not.toHaveBeenCalled();
  });
});

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

describe("context validation", () => {
  it.each(["context_before", "context_after"])("rejects invalid %s values before searching", async (name) => {
    for (const value of [null, -1, 1.5, "2", Number.NaN, 51]) {
      expect(await grepSearchTool.execute({ pattern: "needle", path: directory, [name]: value })).toEqual({
        output: `${name} must be an integer from 0 to 50`,
        isError: true,
      });
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"])("rejects context with files_only on %s but allows zero", async (os) => {
    vi.mocked(platform).mockReturnValue(os as NodeJS.Platform);
    const target = await file("fixture.ts");
    expect(await grepSearchTool.execute({ pattern: "needle", path: target, files_only: true, context_after: 1 })).toEqual({
      output: "context_before and context_after cannot be used with files_only.",
      isError: true,
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(await grepSearchTool.execute({ pattern: "needle", path: target, files_only: true, context_before: 0, context_after: 0 }))
      .toEqual({ output: target, isError: false });
  });
});

describe("fixed_strings validation", () => {
  it.each([null, "true", 1, {}])("rejects malformed fixed_strings: %s", async value => {
    const result = await grepSearchTool.execute({ pattern: "needle", path: directory, fixed_strings: value });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fixed_strings");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects a fixed_strings pattern containing a newline", async () => {
    const result = await grepSearchTool.execute({ pattern: "foo\nbar", path: directory, fixed_strings: true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("newlines");
    expect(execFile).not.toHaveBeenCalled();
  });
});

it.each([null, false, "", "src/*.ts", "[a-z].ts", "a\nb", "a\\b"])("rejects exclude %j before running a backend", async (exclude) => {
  vi.mocked(platform).mockClear();
  const result = await grepSearchTool.execute({ pattern: "needle", exclude });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("exclude");
  expect(platform).not.toHaveBeenCalled();
});
