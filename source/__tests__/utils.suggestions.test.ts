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
