import { describe, it, expect } from "vitest";

import { wrapTextToRuns, targetToRefId, type LineRunSpec } from "../utils/wrap-runs.js";
import { wrapToWidth } from "../utils/wrap-text.js";
import type { DetectedTarget } from "../utils/detect-targets.js";
import { encodeOpenRef } from "../utils/open-ref.js";

function makeTarget(overrides: Partial<DetectedTarget> & Pick<DetectedTarget, "kind" | "text" | "start" | "end">): DetectedTarget {
  return { ...overrides };
}

function linesText(result: LineRunSpec[][]): string[] {
  return result.map((runs) => runs.map((r) => r.text).join(""));
}

describe("wrapTextToRuns", () => {
  it("matches wrapToWidth exactly with no targets, each line a single plain run", () => {
    const text = "hello world, this wraps across lines";
    const width = 10;
    const result = wrapTextToRuns(text, width, [], () => "x");
    const expected = wrapToWidth(text, width);

    expect(linesText(result)).toEqual(expected);
    for (const runs of result) {
      expect(runs).toHaveLength(1);
      expect(runs[0]!.targetId).toBeUndefined();
    }
  });

  it("makes a target that lands on a single wrapped line into one clickable run", () => {
    // "world" sits entirely inside the first wrapped line at width 12.
    const text = "hello world and more text that keeps going";
    const width = 12;
    const start = text.indexOf("world");
    const end = start + "world".length;
    const target = makeTarget({ kind: "path", text: "world", start, end });

    const lines = wrapToWidth(text, width);
    const firstLineIndex = lines.findIndex((l) => l.includes("world"));
    expect(firstLineIndex).toBeGreaterThanOrEqual(0);

    const makeTargetId = (t: DetectedTarget) => `id:${t.text}`;
    const result = wrapTextToRuns(text, width, [target], makeTargetId);

    expect(linesText(result)).toEqual(lines);

    const runsOnLine = result[firstLineIndex]!;
    const clickable = runsOnLine.filter((r) => r.targetId !== undefined);
    expect(clickable).toHaveLength(1);
    expect(clickable[0]!.targetId).toBe("id:world");

    // Concatenating all runs on that line reproduces the plain line text.
    expect(runsOnLine.map((r) => r.text).join("")).toBe(lines[firstLineIndex]);
  });

  it("gives both halves of a target straddling a wrap boundary the same targetId", () => {
    // A single long unbroken token forces wrapToWidth to hard-break it mid
    // token; the target covers the whole token, so it necessarily straddles
    // the resulting wrap boundary.
    const text = "start_aaaaaaaaaaaaaaaaaaaaaaend more words after it";
    const width = 10;
    const tokenStart = text.indexOf("start_aaaaaaaaaaaaaaaaaaaaaaend");
    const tokenEnd = tokenStart + "start_aaaaaaaaaaaaaaaaaaaaaaend".length;
    const target = makeTarget({ kind: "path", text: text.slice(tokenStart, tokenEnd), start: tokenStart, end: tokenEnd });

    const makeTargetId = () => "straddling-id";
    const result = wrapTextToRuns(text, width, [target], makeTargetId);
    const lines = wrapToWidth(text, width);
    expect(linesText(result)).toEqual(lines);

    // Find every line that contains a run with our targetId.
    const linesWithTarget = result.filter((runs) => runs.some((r) => r.targetId === "straddling-id"));
    expect(linesWithTarget.length).toBeGreaterThanOrEqual(2);
    for (const runs of linesWithTarget) {
      const run = runs.find((r) => r.targetId === "straddling-id")!;
      expect(run.targetId).toBe("straddling-id");
    }
  });

  it("handles multiple non-overlapping targets on the same short line", () => {
    const text = "alpha beta gamma";
    const width = 40; // whole thing fits on one line
    const alphaStart = text.indexOf("alpha");
    const alphaEnd = alphaStart + "alpha".length;
    const gammaStart = text.indexOf("gamma");
    const gammaEnd = gammaStart + "gamma".length;

    const targets: DetectedTarget[] = [
      makeTarget({ kind: "path", text: "alpha", start: alphaStart, end: alphaEnd }),
      makeTarget({ kind: "path", text: "gamma", start: gammaStart, end: gammaEnd }),
    ];
    const makeTargetId = (t: DetectedTarget) => `id:${t.text}`;
    const result = wrapTextToRuns(text, width, targets, makeTargetId);

    expect(result).toHaveLength(1);
    const runs = result[0]!;
    const alphaRun = runs.find((r) => r.targetId === "id:alpha");
    const gammaRun = runs.find((r) => r.targetId === "id:gamma");
    expect(alphaRun?.text).toBe("alpha");
    expect(gammaRun?.text).toBe("gamma");

    // Plain text " beta " preserved around/between them.
    const plainRuns = runs.filter((r) => r.targetId === undefined);
    expect(plainRuns.map((r) => r.text).join("")).toContain("beta");

    expect(runs.map((r) => r.text).join("")).toBe(text);
  });

  it("never loses or duplicates characters across many text/width/target combinations", () => {
    const cases: { text: string; width: number; targets: DetectedTarget[] }[] = [
      {
        text: "the quick brown fox jumps over the lazy dog again and again",
        width: 9,
        targets: [],
      },
      {
        text: "see src/app.ts and also docs/readme.md for context on this",
        width: 15,
        targets: (() => {
          const t = "see src/app.ts and also docs/readme.md for context on this";
          const aStart = t.indexOf("src/app.ts");
          const bStart = t.indexOf("docs/readme.md");
          return [
            makeTarget({ kind: "path", text: "src/app.ts", start: aStart, end: aStart + "src/app.ts".length }),
            makeTarget({ kind: "path", text: "docs/readme.md", start: bStart, end: bStart + "docs/readme.md".length }),
          ];
        })(),
      },
      {
        text: "a".repeat(50),
        width: 7,
        targets: [makeTarget({ kind: "path", text: "a".repeat(50), start: 0, end: 50 })],
      },
      {
        text: "  leading and trailing spaces   ",
        width: 6,
        targets: [],
      },
    ];

    for (const { text, width, targets } of cases) {
      const result = wrapTextToRuns(text, width, targets, (t) => `id:${t.start}`);
      const expectedJoined = wrapToWidth(text, width).join("");
      const actualJoined = result.map((runs) => runs.map((r) => r.text).join("")).join("");
      expect(actualJoined, JSON.stringify({ text, width })).toBe(expectedJoined);
    }
  });
});

describe("targetToRefId", () => {
  it("builds a url OpenRef for a url target", () => {
    const target: DetectedTarget = { kind: "url", text: "https://example.com/x", start: 0, end: 21 };
    const encode = (ref: any) => JSON.stringify(ref);
    const id = targetToRefId(target, encode);
    expect(JSON.parse(id)).toEqual({ kind: "url", url: "https://example.com/x" });
  });

  it("builds a path OpenRef with absPath/line/col for a path target", () => {
    const target: DetectedTarget = {
      kind: "path",
      text: "src/app.ts:12:5",
      start: 0,
      end: 15,
      absPath: "/abs/src/app.ts",
      line: 12,
      col: 5,
    };
    const encode = (ref: any) => JSON.stringify(ref);
    const id = targetToRefId(target, encode);
    expect(JSON.parse(id)).toEqual({ kind: "path", absPath: "/abs/src/app.ts", line: 12, col: 5 });
  });

  it("round-trips through the real encodeOpenRef", () => {
    const urlTarget: DetectedTarget = { kind: "url", text: "https://x.test", start: 0, end: 14 };
    const encoded = targetToRefId(urlTarget, encodeOpenRef);
    expect(JSON.parse(encoded)).toEqual({ kind: "url", url: "https://x.test" });
  });
});
