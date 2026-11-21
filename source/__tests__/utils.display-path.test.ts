import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir };
});

import {
  _clearConfigCache,
  projectRelativePath,
  terminalRelativePaths,
  terminalToolValue,
  toolPathValues,
} from "../utils/display-path.js";

const root = "/work/project";
let scratch: string;

/** Writes `hideAbsolutePath` into the (scratch) project's `.agav/config.json`. */
function projectConfig(hideAbsolutePath: boolean): void {
  mkdirSync(join(scratch, "project", ".agav"), { recursive: true });
  writeFileSync(join(scratch, "project", ".agav", "config.json"), JSON.stringify({ hideAbsolutePath }));
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "agav-display-path-"));
  home.dir = join(scratch, "home");
  mkdirSync(join(scratch, "project"), { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(join(scratch, "project"));
  _clearConfigCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe("projectRelativePath", () => {
  it("makes a path under root relative, and root itself '.'", () => {
    expect(projectRelativePath("/work/project/src/app.ts", root)).toBe("src/app.ts");
    expect(projectRelativePath("/work/project", root)).toBe(".");
  });

  it("returns path.relative for a path outside root", () => {
    expect(projectRelativePath("/work/other/file.ts", root)).toBe("../other/file.ts");
  });

  it("strips a leading ./ from a relative path, and keeps '.' for './'", () => {
    expect(projectRelativePath("./src/app.ts", root)).toBe("src/app.ts");
    expect(projectRelativePath("src/app.ts", root)).toBe("src/app.ts");
    expect(projectRelativePath("./", root)).toBe(".");
    expect(projectRelativePath("", root)).toBe("");
  });

  it("shows absolute paths when the project config sets hideAbsolutePath: true", () => {
    projectConfig(true);
    expect(projectRelativePath("/work/project/src/app.ts", root)).toBe("/work/project/src/app.ts");
    expect(projectRelativePath("./src/app.ts", root)).toBe("/work/project/src/app.ts");
  });
});

describe("toolPathValues", () => {
  it("picks up path-like keys and skips non-strings and other keys", () => {
    expect(
      toolPathValues({
        path: "a.ts",
        file_path: "b.ts",
        filename: "c.ts",
        dir: "src",
        cwd: "/work",
        root: "/r",
        target_directory: "lib",
        content: "not a path",
        line: 3,
        file: 42,
      }),
    ).toEqual(["a.ts", "b.ts", "c.ts", "src", "/work", "/r", "lib"]);
    expect(toolPathValues(undefined)).toEqual([]);
  });
});

describe("terminalRelativePaths", () => {
  it("strips the root prefix from embedded paths and turns a bare root into '.'", () => {
    expect(terminalRelativePaths("edited /work/project/src/app.ts and /work/project/README.md", [], root)).toBe(
      "edited src/app.ts and README.md",
    );
    expect(terminalRelativePaths("cd /work/project", [], root)).toBe("cd .");
  });

  it("leaves paths outside root alone, unless a path value names them", () => {
    expect(terminalRelativePaths("read /work/other/x.ts", [], root)).toBe("read /work/other/x.ts");
    expect(terminalRelativePaths("read /work/other/x.ts", ["/work/other/x.ts"], root)).toBe("read ../other/x.ts");
  });

  it("returns the text unchanged when absolute paths are shown", () => {
    projectConfig(true);
    expect(terminalRelativePaths("edited /work/project/src/app.ts", [], root)).toBe("edited /work/project/src/app.ts");
  });
});

describe("terminalToolValue", () => {
  it("formats a path-like string argument as a project path, and JSON-encodes other values", () => {
    expect(terminalToolValue("path", "./src/app.ts")).toBe("src/app.ts");
    expect(terminalToolValue("count", 3)).toBe("3");
    expect(terminalToolValue("tags", ["a", "b"])).toBe('["a","b"]');
  });
});
