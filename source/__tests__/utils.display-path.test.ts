import { beforeEach, describe, expect, it } from "vitest";
import { relative } from "node:path";

const { projectRelativePath, terminalRelativePaths, toolPathValues, terminalToolValue, _clearConfigCache } =
  await import("../utils/display-path.js");

const ROOT = "/repo/project";
beforeEach(() => _clearConfigCache());

describe("projectRelativePath", () => {
  it("makes an absolute path under root relative", () => {
    expect(projectRelativePath("/repo/project/src/a.ts", ROOT)).toBe("src/a.ts");
  });
  it("returns path.relative for a path outside root", () => {
    expect(projectRelativePath("/other/b.ts", ROOT)).toBe(relative(ROOT, "/other/b.ts"));
  });
  it("normalises '.' and './x' and leaves relative paths alone", () => {
    expect(projectRelativePath(".", ROOT)).toBe(".");
    expect(projectRelativePath("./x", ROOT)).toBe("x");
    expect(projectRelativePath("src/a.ts", ROOT)).toBe("src/a.ts");
    expect(projectRelativePath("", ROOT)).toBe("");
  });
});

describe("toolPathValues", () => {
  it("collects path-like string arguments and skips non-strings", () => {
    expect(toolPathValues({ path: "/a", file: "/b", dir: "/c", cwd: "/d", root: "/e", name: "x", count: 5 }))
      .toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });
  it("returns an empty array for missing input", () => {
    expect(toolPathValues()).toEqual([]);
  });
});

describe("terminalRelativePaths", () => {
  it("strips the root prefix from embedded paths", () => {
    expect(terminalRelativePaths("/repo/project/src/a.ts", [], ROOT)).toBe("src/a.ts");
  });
  it("rewrites an explicit path value outside root", () => {
    expect(terminalRelativePaths("see /other/b.ts", ["/other/b.ts"], ROOT)).toBe("see " + relative(ROOT, "/other/b.ts"));
  });
  it("returns empty text unchanged", () => {
    expect(terminalRelativePaths("", [], ROOT)).toBe("");
  });
});

describe("terminalToolValue", () => {
  it("formats a path-like string argument and leaves others untouched", () => {
    expect(terminalToolValue("path", "src/a.ts")).toBe("src/a.ts");
    expect(terminalToolValue("name", "hello")).toBe("hello");
  });
});
