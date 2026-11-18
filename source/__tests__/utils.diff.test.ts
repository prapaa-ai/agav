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

describe("diff line numbers and boundaries", () => {
  it("numbers trailing context after expanding the first line", () => {
    expect(computeEditDiff("one\ntail", "one", "first\nsecond")).toEqual([
      { type: "remove", lineNo: 1, text: "one" },
      { type: "add", lineNo: 1, text: "first" },
      { type: "add", lineNo: 2, text: "second" },
      { type: "context", lineNo: 3, text: "tail" },
    ]);
  });

  it("numbers trailing context after contracting two lines", () => {
    expect(computeEditDiff("top\nfirst\nsecond\ntail", "first\nsecond", "one")).toEqual([
      { type: "context", lineNo: 1, text: "top" },
      { type: "remove", lineNo: 2, text: "first" },
      { type: "remove", lineNo: 3, text: "second" },
      { type: "add", lineNo: 2, text: "one" },
      { type: "context", lineNo: 3, text: "tail" },
    ]);
  });

  it("ends a last-line edit without a trailing separator", () => {
    expect(computeEditDiff("a\nb\nc", "c", "z", 1)).toEqual([
      { type: "separator", text: "..." },
      { type: "context", lineNo: 2, text: "b" },
      { type: "remove", lineNo: 3, text: "c" },
      { type: "add", lineNo: 3, text: "z" },
    ]);
  });

  it("separates zero-context hunks and joins them when context fills the gap", () => {
    const first = [
      { type: "remove", lineNo: 1, text: "a" },
      { type: "add", lineNo: 1, text: "x" },
    ];
    const last = [
      { type: "remove", lineNo: 3, text: "c" },
      { type: "add", lineNo: 3, text: "z" },
    ];
    expect(computeDiff("a\nb\nc", "x\nb\nz", 0)).toEqual([...first, { type: "separator", text: "..." }, ...last]);
    expect(computeDiff("a\nb\nc", "x\nb\nz", 1)).toEqual([...first, { type: "context", lineNo: 2, text: "b" }, ...last]);
  });
});
