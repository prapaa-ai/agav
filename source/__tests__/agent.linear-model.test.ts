import { describe, expect, it } from "vitest";

import { extractFeatures, tokenize, FEATURE_DIM } from "../agent/text-features.js";
import { LinearClassifier, parseModelWeights } from "../agent/linear-model.js";

describe("text features", () => {
  it("tokenizes to lowercased word tokens", () => {
    expect(tokenize("Refactor the Auth-module!")).toEqual(["refactor", "the", "auth", "module"]);
  });

  it("produces a fixed-dimension L2-normalized vector", () => {
    const v = extractFeatures("what is a closure");
    expect(v.length).toBe(FEATURE_DIM);
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
  });

  it("is deterministic", () => {
    const a = extractFeatures("fix the bug in loop.ts");
    const b = extractFeatures("fix the bug in loop.ts");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("empty text still normalizes (only the length-bucket signal fires)", () => {
    const v = extractFeatures("");
    // Empty is "short", so exactly one structural bucket is set → unit vector.
    const nonZero = Array.from(v).filter((x) => x !== 0);
    expect(nonZero.length).toBe(1);
    expect(nonZero[0]).toBeCloseTo(1, 6);
  });
});

describe("LinearClassifier", () => {
  it("rejects a dimension mismatch", () => {
    expect(() => new LinearClassifier({ dim: 8, weights: [0, 0, 0, 0, 0, 0, 0, 0], bias: 0 })).toThrow();
  });

  it("predicts a probability in [0,1]", () => {
    const weights = new Array(FEATURE_DIM).fill(0);
    const clf = new LinearClassifier({ dim: FEATURE_DIM, weights, bias: 0 });
    const p = clf.predictHardProbability("anything");
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
    expect(p).toBeCloseTo(0.5, 6); // zero weights + zero bias → 0.5
  });
});

describe("parseModelWeights", () => {
  const valid = { dim: FEATURE_DIM, weights: new Array(FEATURE_DIM).fill(0.1), bias: 0.2 };

  it("accepts a valid model", () => {
    const m = parseModelWeights(valid);
    expect(m).not.toBeNull();
    expect(m!.bias).toBe(0.2);
  });

  it("rejects wrong dimension", () => {
    expect(parseModelWeights({ ...valid, dim: 8 })).toBeNull();
  });

  it("rejects weights length mismatch", () => {
    expect(parseModelWeights({ ...valid, weights: [0.1, 0.2] })).toBeNull();
  });

  it("rejects non-numeric weights", () => {
    const bad = { ...valid, weights: [...new Array(FEATURE_DIM - 1).fill(0.1), "x"] };
    expect(parseModelWeights(bad)).toBeNull();
  });

  it("rejects junk", () => {
    expect(parseModelWeights(null)).toBeNull();
    expect(parseModelWeights("nope")).toBeNull();
    expect(parseModelWeights({})).toBeNull();
  });
});

describe("bundled weights round-trip", () => {
  it("the shipped weights file loads and classifies", async () => {
    const mod = await import("../agent/task-classifier-weights.json", { with: { type: "json" } });
    const weights = parseModelWeights((mod as { default?: unknown }).default ?? mod);
    expect(weights, "shipped weights must parse").not.toBeNull();
    const clf = new LinearClassifier(weights!);
    // Sanity: a clear lookup scores lower P(hard) than a clear code task.
    const pSimple = clf.predictHardProbability("what is a closure");
    const pHard = clf.predictHardProbability("refactor the auth module and fix the tests");
    expect(pHard).toBeGreaterThan(pSimple);

    // Held-out-ish generalization: phrasings not in the training set should
    // still land on the right side of 0.5, proving the runtime features match
    // what the trainer used (a feature-extraction drift would break this).
    const heldOutSimple = ["what is a vector clock", "explain what a coroutine is"];
    const heldOutHard = ["add retry logic to the http client", "fix the null pointer in parser.ts"];
    for (const t of heldOutSimple) expect(clf.predictHardProbability(t), t).toBeLessThan(0.5);
    for (const t of heldOutHard) expect(clf.predictHardProbability(t), t).toBeGreaterThan(0.5);
  });
});
