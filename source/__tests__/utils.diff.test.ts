import { describe, it, expect } from "vitest";

import { computeDiff, computeEditDiff } from "../utils/diff.js";

describe("utils/diff", () => {
  it("returns no diff for identical text", () => {
    expect(computeDiff("same\ntext", "same\ntext")).toEqual([]);
  });

  it("computes add/remove hunks with separators", () => {
    const diff = computeDiff("a\nb\nc\nd", "a\nx\nc\ny", 0);
    expect(diff.some((line) => line.type === "add")).toBe(true);
    expect(diff.some((line) => line.type === "remove")).toBe(true);
    expect(diff.some((line) => line.type === "separator")).toBe(true);
  });

  it("returns edit diff around replaced content", () => {
    const diff = computeEditDiff("one\ntwo\nthree\nfour", "two", "2");
    expect(diff.map((line) => line.type)).toContain("remove");
    expect(diff.map((line) => line.type)).toContain("add");
    expect(diff.some((line) => line.text === "one")).toBe(true);
    expect(diff.some((line) => line.text === "four")).toBe(true);
  });

  it("returns empty when old string is missing", () => {
    expect(computeEditDiff("abc", "zzz", "yyy")).toEqual([]);
  });
});
