import { describe, it, expect } from "vitest";

import { computeDiff, computeEditDiff, type DiffLine } from "../utils/diff.js";

/** "type lineNo text" per line, so a whole hunk can be asserted exactly. */
const shape = (lines: DiffLine[]) =>
  lines.map((line) => `${line.type}${line.lineNo === undefined ? "" : ` ${line.lineNo}`} ${line.text}`);

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

  it("renumbers the context after a one-line edit that becomes two", () => {
    expect(shape(computeEditDiff("a\nb\nc", "b", "B1\nB2", 1))).toEqual([
      "context 1 a",
      "remove 2 b",
      "add 2 B1",
      "add 3 B2",
      "context 4 c",
    ]);
  });

  it("renumbers the context after a two-line edit that becomes one", () => {
    expect(shape(computeEditDiff("a\nB1\nB2\nc", "B1\nB2", "b", 1))).toEqual([
      "context 1 a",
      "remove 2 B1",
      "remove 3 B2",
      "add 2 b",
      "context 3 c",
    ]);
  });

  it("keeps the first line's numbering when the edit is at the start of the file", () => {
    expect(shape(computeEditDiff("one\ntwo", "one", "ONE", 3))).toEqual([
      "remove 1 one",
      "add 1 ONE",
      "context 2 two",
    ]);
  });

  it("numbers an append after the existing lines", () => {
    expect(shape(computeDiff("a\nb\nc\nd", "a\nb\nc\nd\ne"))).toEqual([
      "context 2 b",
      "context 3 c",
      "context 4 d",
      "add 5 e",
    ]);
  });

  it("keeps the last line's numbering when the edit is at the end of the file", () => {
    expect(shape(computeDiff("a\nb", "a\nc"))).toEqual([
      "context 1 a",
      "remove 2 b",
      "add 2 c",
    ]);
  });

  it("separates two distant hunks with one-tenth the context and merges them with the default", () => {
    const oldText = "1\n2\n3\n4\n5\n6\n7\n8\n9";
    const newText = "1\nX\n3\n4\n5\n6\n7\nY\n9";

    expect(shape(computeDiff(oldText, newText, 1))).toEqual([
      "context 1 1",
      "remove 2 2",
      "add 2 X",
      "context 3 3",
      "separator ...",
      "context 7 7",
      "remove 8 8",
      "add 8 Y",
      "context 9 9",
    ]);

    expect(shape(computeDiff(oldText, newText, 3))).toEqual([
      "context 1 1",
      "remove 2 2",
      "add 2 X",
      "context 3 3",
      "context 4 4",
      "context 5 5",
      "context 6 6",
      "context 7 7",
      "remove 8 8",
      "add 8 Y",
      "context 9 9",
    ]);
    expect(computeDiff(oldText, newText, 3).some((line) => line.type === "separator")).toBe(false);
  });
});
