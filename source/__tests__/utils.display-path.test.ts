import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module memoises its config read, so each case resets the fs mock and the
// cache. No real ~/.agav/config.json is consulted.
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => "/home/tester",
}));

import { existsSync, readFileSync } from "node:fs";
import {
  _clearConfigCache, projectRelativePath, terminalRelativePaths, terminalToolValue, toolPathValues,
} from "../utils/display-path.js";

const ROOT = "/work/project";

/** Default install: no config file, so absolute paths are shortened. */
function defaultConfig() {
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(readFileSync).mockReset();
}

/** `hideAbsolutePath: true` in the project config keeps absolute paths as-is. */
function keepAbsolutePaths() {
  vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith("/.agav/config.json"));
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ hideAbsolutePath: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  defaultConfig();
  _clearConfigCache();
});

describe("projectRelativePath", () => {
  it("shortens absolute paths under the root", () => {
    expect(projectRelativePath(`${ROOT}/src/a.ts`, ROOT)).toBe("src/a.ts");
    expect(projectRelativePath(ROOT, ROOT)).toBe(".");
  });

  it("uses path.relative for a path outside the root", () => {
    expect(projectRelativePath("/elsewhere/file.txt", ROOT)).toBe("../../elsewhere/file.txt");
  });

  it("leaves relative input relative and drops a leading ./", () => {
    expect(projectRelativePath("src/a.ts", ROOT)).toBe("src/a.ts");
    expect(projectRelativePath("./src/a.ts", ROOT)).toBe("src/a.ts");
    expect(projectRelativePath(".", ROOT)).toBe(".");
    expect(projectRelativePath("", ROOT)).toBe("");
  });

  it("resolves relative input instead of shortening it when absolute paths stay visible", () => {
    keepAbsolutePaths();
    _clearConfigCache();
    expect(projectRelativePath(`${ROOT}/src/a.ts`, ROOT)).toBe(`${ROOT}/src/a.ts`);
    expect(projectRelativePath("src/a.ts", ROOT)).toBe(`${ROOT}/src/a.ts`);
  });
});

describe("toolPathValues", () => {
  it("collects path-like string fields only", () => {
    expect(toolPathValues({
      path: "a", file: "b", filename: "c", directory: "d", dir: "e", cwd: "f", root: "g", tool_path: "h",
      query: "not a path", depth: 3, pathCount: 2, pathway: "no",
    })).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  it("returns nothing for a missing input", () => {
    expect(toolPathValues()).toEqual([]);
  });
});

describe("terminalRelativePaths", () => {
  const text = `opened ${ROOT}/src/a.ts and ${ROOT}/README.md then ${ROOT}`;

  it("strips the root prefix and shortens known absolute values", () => {
    expect(terminalRelativePaths(text, [], ROOT)).toBe("opened src/a.ts and README.md then .");
  });

  it("replaces a path value that appears with punctuation around it", () => {
    expect(terminalRelativePaths(`saved to "${ROOT}/out/a.mp4".`, [`${ROOT}/out/a.mp4`], ROOT))
      .toBe('saved to "out/a.mp4".');
  });

  it("leaves text untouched without a config shortening request", () => {
    keepAbsolutePaths();
    _clearConfigCache();
    expect(terminalRelativePaths(text, [], ROOT)).toBe(text);
  });

  it("returns short or empty text unchanged", () => {
    expect(terminalRelativePaths("", [], ROOT)).toBe("");
    expect(terminalRelativePaths("plain", [], ROOT)).toBe("plain");
  });
});

describe("terminalToolValue", () => {
  // These helpers default their root to process.cwd().
  beforeEach(() => { vi.spyOn(process, "cwd").mockReturnValue(ROOT); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("formats a path field and leaves other fields to text shortening", () => {
    expect(terminalToolValue("path", `${ROOT}/a.ts`)).toBe("a.ts");
    expect(terminalToolValue("command", `cat ${ROOT}/a.ts`)).toBe("cat a.ts");
  });

  it("serialises non-string values before shortening them", () => {
    expect(terminalToolValue("meta", { file: `${ROOT}/a.ts` })).toBe('{"file":"a.ts"}');
  });
});
