import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
import { findFilesTool } from "../tools/find-files.js";

const excludedDirectories = ["node_modules", ".git", "build", "dist", ".next", ".venv", "__pycache__", "coverage"];
const originalDirectory = process.cwd();
let directory: string;
let nativeAvailable = process.platform !== "win32";
if (nativeAvailable) {
  try { execFileSync("find", [".", "-prune"], { stdio: "pipe" }); } catch { nativeAvailable = false; }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agav-find-test-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  process.chdir(originalDirectory);
  vi.mocked(platform).mockReset();
  await rm(directory, { recursive: true, force: true });
});
async function file(name: string) {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "test\n");
  return path;
}
async function expectFiles(path: string, expected: string[], pattern = "*.ts") {
  const result = await findFilesTool.execute({ pattern, path });
  expect(result.isError).toBe(false);
  expect(result.output.split("\n").sort()).toEqual(expected.sort());
}

for (const backend of ["native", "fallback"] as const) {
  describe.skipIf(backend === "native" && !nativeAvailable)(`find_files ${backend}`, () => {
    beforeEach(() => {
      vi.mocked(platform).mockReturnValue(backend === "native" ? "darwin" : "win32");
    });
    afterEach(() => {
      if (backend === "fallback") expect(execFile).not.toHaveBeenCalled();
      else expect(execFile).toHaveBeenCalled();
    });

    it("skips all eight exclusions at the root and nested, including a default path", async () => {
      const visible = await file("src/visible.ts");
      for (const excluded of excludedDirectories) {
        await file(`${excluded}/noise.ts`);
        await file(`src/${excluded}/noise.ts`);
      }
      await expectFiles(directory, [visible]);
      process.chdir(directory);
      expect(await findFilesTool.execute({ pattern: "*.ts" })).toEqual({
        output: join(process.cwd(), "src/visible.ts"), isError: false,
      });
    });

    it("keeps noisy excluded files out of capped results", async () => {
      for (const excluded of excludedDirectories) {
        for (let i = 0; i < 30; i++) await file(`${excluded}/noise-${i}.ts`);
      }
      const visible: string[] = [];
      for (let i = 0; i < 205; i++) visible.push(await file(`src/visible-${i}.ts`));
      const result = await findFilesTool.execute({ pattern: "*.ts", path: directory });
      expect(result.isError).toBe(false);
      const lines = result.output.split("\n");
      expect(lines).toHaveLength(201);
      expect(new Set(lines.slice(0, 200)).size).toBe(200);
      expect(lines.slice(0, 200).every((path) => visible.includes(path))).toBe(true);
      // Preserve the existing backend-specific cap messages.
      expect(lines[200]).toBe(backend === "native" ? "... 5 more files" : "... 0 more files");
    });

    it.each(excludedDirectories)("searches explicit %s roots and paths inside excluded ancestors", async (excluded) => {
      const direct = await file(`${excluded}/generated.ts`);
      const nested = await file(`${excluded}/inner/nested.ts`);
      for (const child of excludedDirectories) await file(`${excluded}/inner/${child}/skipped.ts`);
      await expectFiles(join(directory, excluded), [direct, nested]);
      await expectFiles(join(directory, excluded, "inner"), [nested]);
      await expectFiles(join(directory, excluded, "inner", "build"), [join(directory, excluded, "inner", "build", "skipped.ts")]);
    });

    it.each(["space root", "brackets[ab]", "star*", "question?", "back\\slash", "unicode-雪-é", "all [] * ? \\ 雪"])(
      "handles literal root metacharacters and unicode: %s", async (parent) => {
        const root = join(directory, parent, "build");
        const target = await file(`${parent}/build/visible.ts`);
        await file(`${parent}/build/build/skipped.ts`);
        await file(`${parent}/build/inner/coverage/skipped.ts`);
        await expectFiles(root, [target]);
      },
    );

    it("preserves glob, case and no-match behavior", async () => {
      const lower = await file("config-a.ts");
      const upper = await file("CONFIG-B.TS");
      await file("notes.txt");
      await expectFiles(directory, backend === "native" ? [lower] : [lower, upper], "config-?.ts");
      expect(await findFilesTool.execute({ pattern: "absent*", path: directory })).toEqual({ output: "No files found.", isError: false });
    });

    it("does not exclude ordinary files whose basenames are excluded directory names", async () => {
      const targets = await Promise.all(excludedDirectories.map((name) => file(`src/${name}`)));
      await expectFiles(directory, targets, "*");
    });
  });
}

describe.skipIf(!nativeAvailable)("find_files native pruning", () => {
  beforeEach(() => { vi.mocked(platform).mockReturnValue("darwin"); });

  it("uses directory basename pruning and actually prevents visiting excluded descendants", async () => {
    await file("src/visible.ts");
    for (const excluded of excludedDirectories) await file(`src/${excluded}/deep/noise.ts`);
    await findFilesTool.execute({ pattern: "*.ts", path: directory });
    const [command, args, options] = vi.mocked(execFile).mock.calls[0]!;
    expect(command).toBe("find");
    expect(options).toEqual({ maxBuffer: 200_000, timeout: 15_000 });
    const names = excludedDirectories.flatMap((name, i) => i === 0 ? ["-name", name] : ["-o", "-name", name]);
    expect(args).toEqual([
      resolve(directory), "(", "-type", "d", "!", "-path", resolve(directory), "(", ...names, ")", "-prune", ")",
      "-o", "(", "-type", "f", "-name", "*.ts", "-print", ")",
    ]);
    // Replace only the file branch with a visit probe: post-filtering results
    // would still expose excluded descendants to this real find invocation.
    const probe = [...(args as string[]).slice(0, -7), "-print"];
    const visited = execFileSync("find", probe, { encoding: "utf8" }).trimEnd().split("\n");
    expect(visited).toContain(join(directory, "src", "visible.ts"));
    for (const excluded of excludedDirectories) {
      expect(visited.some((path) => path.startsWith(join(directory, "src", excluded) + "/"))).toBe(false);
    }
  });

  it.each(excludedDirectories)("preserves explicit native files in excluded ancestors and named %s", async (excluded) => {
    const target = await file(`${excluded}/inner/single.ts`);
    await expectFiles(target, [target]);
    await expectFiles(target, ["No files found."], "*.py");
    const named = await file(`files/${excluded}`);
    await expectFiles(named, [named], "*");
  });
});

describe("find_files native output and fallback policy", () => {
  beforeEach(() => { vi.mocked(platform).mockReturnValue("linux"); });
  function response(error: Error | null, stdout: string, stderr = "") {
    vi.mocked(execFile).mockImplementationOnce(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(error, stdout, stderr);
    }) as typeof execFile);
  }
  it("preserves native ordering and truncation", async () => {
    const paths = Array.from({ length: 203 }, (_, i) => join(directory, `${203 - i}.ts`));
    response(null, paths.join("\n") + "\n");
    expect(await findFilesTool.execute({ pattern: "*", path: directory })).toEqual({ output: paths.slice(0, 200).join("\n") + "\n... 3 more files", isError: false });
  });
  it("falls back when native find is absent", async () => {
    const target = await file("src/visible.ts");
    await file("coverage/noise.ts");
    response(Object.assign(new Error("not found"), { code: "ENOENT" }), "");
    await expectFiles(directory, [target]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it("keeps native errors without falling back, and keeps partial output", async () => {
    await file("visible.ts");
    response(new Error("failed"), "", "permission denied");
    expect(await findFilesTool.execute({ pattern: "*", path: directory })).toEqual({ output: "permission denied", isError: true });
    response(new Error("failed"), "/partial.ts\n", "permission denied");
    expect(await findFilesTool.execute({ pattern: "*", path: directory })).toEqual({ output: "/partial.ts", isError: false });
  });
  it("retains fallback detection for non-Unix find", async () => {
    const target = await file("visible.ts");
    response(new Error("failed"), "", "Parameter format not correct");
    await expectFiles(directory, [target]);
  });
});
