import { describe, it, expect, beforeAll } from "vitest";
import chalk from "chalk";

import { buildClickableLines } from "../utils/render-clickable.js";
import { wrapStyled } from "../components/markdown-text.js";
import type { DetectedTarget } from "../utils/detect-targets.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeTarget(text: string, kind: DetectedTarget["kind"] = "path"): DetectedTarget {
  return { kind, text, start: 0, end: text.length };
}

describe("buildClickableLines", () => {
  beforeAll(() => {
    // chalk paints nothing without a detected colour terminal under vitest.
    chalk.level = 3;
  });

  it("returns wrapStyled's lines unchanged (as single plain runs) when there are no targets", () => {
    const styled = chalk.bold("hello ") + "plain world that keeps going and going";
    const width = 12;
    const result = buildClickableLines(styled, width, [], () => "id", {});
    const expected = wrapStyled(styled, width).map((line) => [{ text: line }]);
    expect(result).toEqual(expected);
  });

  it("makes a target's literal text clickable when it's found in the rendered line", () => {
    const styled = `See ${chalk.bold("source/app.ts")} for details`;
    const target = makeTarget("source/app.ts");
    const result = buildClickableLines(styled, 80, [target], () => "target-id", { color: "cyan", underline: true });

    expect(result).toHaveLength(1);
    const clickable = result[0]!.filter((r) => r.targetId !== undefined);
    expect(clickable).toHaveLength(1);
    expect(stripAnsi(clickable[0]!.text)).toBe("source/app.ts");
    expect(clickable[0]!.targetId).toBe("target-id");
  });

  it("renders as plain text with no crash and no phantom link when the target text is absent", () => {
    const styled = "nothing to see here";
    const target = makeTarget("src/not-here.ts");
    const result = buildClickableLines(styled, 80, [target], () => "target-id", {});

    const allRuns = result.flat();
    expect(allRuns.some((r) => r.targetId !== undefined)).toBe(false);
    expect(allRuns.map((r) => stripAnsi(r.text)).join("")).toBe(stripAnsi(styled));
  });

  it("marks both occurrences clickable when the same target text appears twice", () => {
    const styled = "path/a.ts appears here and path/a.ts appears again";
    const target = makeTarget("path/a.ts");
    const result = buildClickableLines(styled, 80, [target], () => "dup-id", {});

    const clickable = result.flat().filter((r) => r.targetId === "dup-id");
    expect(clickable).toHaveLength(2);
    for (const run of clickable) expect(stripAnsi(run.text)).toBe("path/a.ts");
  });

  it("merges/dedupes overlapping occurrences, keeping only non-overlapping runs in order", () => {
    // "abcdef" and "cdefgh" overlap in "abcdefgh" at indices [0,6) and [2,8).
    // Sorted by start, the first occurrence (start 0) is kept; the second
    // (start 2) overlaps [0,6) so per the source's `>= lastEnd` merge rule it
    // is dropped entirely — the source does not attempt to render the
    // non-overlapping tail of a dropped occurrence.
    const styled = "abcdefgh";
    const targetA = makeTarget("abcdef");
    const targetB = makeTarget("cdefgh");
    const result = buildClickableLines(styled, 80, [targetA, targetB], (t) => `id:${t.text}`, {});

    const clickable = result.flat().filter((r) => r.targetId !== undefined);
    expect(clickable).toHaveLength(1);
    expect(clickable[0]!.targetId).toBe("id:abcdef");
    expect(stripAnsi(clickable[0]!.text)).toBe("abcdef");

    // Trailing "gh" (not covered by the kept occurrence) survives as plain text.
    const plain = result.flat().filter((r) => r.targetId === undefined);
    expect(plain.map((r) => stripAnsi(r.text)).join("")).toBe("gh");
  });

  it("applies plainRunStyle to plain runs but not to clickable runs' plain fields", () => {
    const styled = `See ${chalk.bold("source/app.ts")} for details`;
    const target = makeTarget("source/app.ts");
    const result = buildClickableLines(styled, 80, [target], () => "target-id", { color: "cyan", underline: true }, { dimColor: true });

    const runs = result[0]!;
    const plainRuns = runs.filter((r) => r.targetId === undefined);
    const clickableRuns = runs.filter((r) => r.targetId !== undefined);

    expect(plainRuns.length).toBeGreaterThan(0);
    for (const run of plainRuns) expect(run.dimColor).toBe(true);

    expect(clickableRuns).toHaveLength(1);
    expect(clickableRuns[0]!.dimColor).toBeUndefined();
    expect(clickableRuns[0]!.color).toBe("cyan");
    expect(clickableRuns[0]!.underline).toBe(true);
  });

  it("marks both halves of a target that straddles a wrap boundary with the same targetId", () => {
    // Regression: only searching for a target's literal text *within each
    // already-wrapped line* (rather than across the whole rendered text
    // first) meant a target long enough to be hard-broken by the wrap had no
    // single line containing its complete substring, so it never matched at
    // all and silently rendered as plain, unclickable text — the exact
    // "works for some agent-mentioned files but not others" inconsistency.
    const longPath = "a-quite-long-directory-name/another-long-segment/finally-the-file.ts";
    const styled = `See ${longPath} for details`;
    const target = makeTarget(longPath);
    const width = 30;
    const result = buildClickableLines(styled, width, [target], () => "straddling-id", { color: "cyan", underline: true });

    expect(result.length).toBeGreaterThan(1);
    const clickableRuns = result.flat().filter((r) => r.targetId === "straddling-id");
    expect(clickableRuns.length).toBeGreaterThanOrEqual(2);
    // Every clickable fragment concatenates back to the original long path.
    expect(clickableRuns.map((r) => stripAnsi(r.text)).join("")).toBe(longPath);
  });

  it("loses no visible characters across all lines/runs for a styled multi-run input", () => {
    const styled = chalk.bold("hello ") + "plain text about " + chalk.underline.cyan("source/app.ts") + " and more words to force wrapping across several lines of output";
    const width = 20;
    const target = makeTarget("source/app.ts");
    const result = buildClickableLines(styled, width, [target], () => "id", { color: "cyan", underline: true });

    const actual = result.map((runs) => runs.map((r) => stripAnsi(r.text)).join("")).join("");
    const expected = wrapStyled(styled, width).map(stripAnsi).join("");
    expect(actual).toBe(expected);
  });
});
