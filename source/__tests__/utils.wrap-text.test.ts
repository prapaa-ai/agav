import { describe, expect, it } from "vitest";

import { stripAnsi, visualLen, wrapToWidth } from "../utils/wrap-text.js";

/** The invariant the padded background band depends on. */
function fitsOnOneRow(lines: string[], width: number): boolean {
  return lines.every((line) => visualLen(line) <= width && !/[\r\n]/.test(line));
}

describe("wrapToWidth", () => {
  it("leaves text that already fits on one line", () => {
    expect(wrapToWidth("hello there", 40)).toEqual(["hello there"]);
  });

  // The bug behind the torn message band: a newline inside the content used to
  // survive into a rendered line and move the cursor to column 0 mid-row.
  it("splits on hard line breaks instead of emitting a newline inside a line", () => {
    expect(wrapToWidth("yo\nyo", 40)).toEqual(["yo", "yo"]);
    expect(wrapToWidth("a\r\nb\rc", 40)).toEqual(["a", "b", "c"]);
  });

  it("keeps a blank line blank rather than collapsing it", () => {
    expect(wrapToWidth("one\n\ntwo", 40)).toEqual(["one", "", "two"]);
  });

  it("wraps each hard line independently", () => {
    expect(wrapToWidth("aaa bbb ccc\nddd eee fff", 7)).toEqual(["aaa bbb", "ccc", "ddd eee", "fff"]);
  });

  it("cuts a word wider than the row instead of letting it overflow", () => {
    const lines = wrapToWidth("x".repeat(11), 4);
    expect(lines).toEqual(["xxxx", "xxxx", "xxx"]);
    expect(fitsOnOneRow(lines, 4)).toBe(true);
  });

  it("cuts an overlong word that follows text on the same line", () => {
    const lines = wrapToWidth("hi " + "y".repeat(9), 4);
    expect(lines).toEqual(["hi", "yyyy", "yyyy", "y"]);
    expect(fitsOnOneRow(lines, 4)).toBe(true);
  });

  it("measures width in visible characters, ignoring ANSI codes", () => {
    const colored = "\x1b[31mredtext\x1b[39m";
    expect(wrapToWidth(colored, 7)).toEqual([colored]);
  });

  it("wraps wide graphemes by terminal column without splitting them", () => {
    const lines = wrapToWidth("界界界", 4);
    expect(lines).toEqual(["界界", "界"]);
    expect(fitsOnOneRow(lines, 4)).toBe(true);
  });

  it("keeps emoji grapheme clusters intact while wrapping", () => {
    const lines = wrapToWidth("🎉🎉🎉", 4);
    expect(lines).toEqual(["🎉🎉", "🎉"]);
    expect(fitsOnOneRow(lines, 4)).toBe(true);
  });

  it("always returns at least one line", () => {
    expect(wrapToWidth("", 40)).toEqual([""]);
  });

  // A zero or negative width would otherwise spin forever in the cut loop.
  it("terminates on a non-positive width", () => {
    expect(wrapToWidth("abc", 0)).toEqual(["a", "b", "c"]);
    expect(wrapToWidth("abc", -5)).toEqual(["a", "b", "c"]);
  });

  it("never emits a line the terminal would have to wrap", () => {
    const content = "short\n\n" + "z".repeat(200) + "\nsome ordinary trailing words here";
    expect(fitsOnOneRow(wrapToWidth(content, 30), 30)).toBe(true);
  });
});

describe("stripAnsi", () => {
  it("removes SGR sequences and OSC-8 hyperlinks", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[22m")).toBe("bold");
    expect(visualLen("\x1b]8;;https://example.com\x1b\\link")).toBe(4);
  });
});
