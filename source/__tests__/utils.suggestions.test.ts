import { describe, expect, it } from "vitest";
import { findClosest, levenshtein } from "../utils/suggestions.js";

describe("levenshtein", () => {
  it.each([
    ["", "", 0],
    ["effort", "effort", 0],
    ["efrot", "effort", 2],
    ["modl", "model", 1],
    ["kitten", "sitting", 3],
    ["--confog", "--config", 1],
  ])("distance(%j, %j) = %i", (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected);
    expect(levenshtein(b, a)).toBe(expected);
  });

  // Reference: the original full-table implementation.
  function fullTable(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i]![j] = Math.min(
          dp[i - 1]![j]! + 1,
          dp[i]![j - 1]! + 1,
          dp[i - 1]![j - 1]! + (a[i - 1] !== b[j - 1] ? 1 : 0),
        );
    return dp[m]![n]!;
  }

  const sample = [
    "", "a", "ab", "ba", "abc", "model", "modle", "modell", "effort", "efrot",
    "--config", "--confog", "--provider", "--search", "kitten", "sitting", "zzzzzz",
  ];

  it("matches the full-table result for every sample pair", () => {
    for (const a of sample)
      for (const b of sample)
        expect(levenshtein(a, b)).toBe(fullTable(a, b));
  });

  it("returns min(distance, max + 1) when given a cutoff", () => {
    for (const a of sample)
      for (const b of sample)
        for (const max of [0, 1, 2, 3, 4])
          expect(levenshtein(a, b, max)).toBe(Math.min(fullTable(a, b), max + 1));
  });
});

describe("findClosest", () => {
  const candidates = ["--config", "--provider", "--model", "--effort", "--search"];

  it("finds a near-miss candidate", () => {
    expect(findClosest("--confog", candidates)).toBe("--config");
    expect(findClosest("efrot", ["effort", "maxTokens"])).toBe("effort");
  });

  it("returns undefined when nothing is close", () => {
    expect(findClosest("--zzzzzz", candidates)).toBeUndefined();
    expect(findClosest("xyz", [])).toBeUndefined();
  });

  it("skips candidates whose length differs by more than 2", () => {
    expect(findClosest("a", ["errorRetries"])).toBeUndefined();
  });

  it("prefers the closest of several matches", () => {
    expect(findClosest("model", ["modle", "model", "modell"])).toBe("model");
  });
});
