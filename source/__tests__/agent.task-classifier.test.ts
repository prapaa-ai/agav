import { describe, expect, it } from "vitest";

import { classifyHeuristic, classifyWithModel } from "../agent/task-classifier.js";
import { resolveTurnModel } from "../agent/model-tiers.js";

describe("task classifier — heuristic", () => {
  it("classifies short lookups as simple", () => {
    for (const q of [
      "what is a closure?",
      "explain what a promise is",
      "which port does the server use?",
      "define idempotent",
    ]) {
      const c = classifyHeuristic(q);
      expect(c.difficulty, q).toBe("simple");
      expect(c.confidence).toBeGreaterThan(0.5);
    }
  });

  it("classifies action / code turns as hard", () => {
    for (const q of [
      "refactor the auth module",
      "fix the failing test in loop.ts",
      "implement a retry wrapper",
      "add a new endpoint",
      "why does foo.ts throw an error?",
      "debug this stack trace",
    ]) {
      expect(classifyHeuristic(q).difficulty, q).toBe("hard");
    }
  });

  it("defaults empty and long inputs to hard", () => {
    expect(classifyHeuristic("").difficulty).toBe("hard");
    expect(classifyHeuristic("x".repeat(500)).difficulty).toBe("hard");
  });

  it("treats code artifacts as hard even in a question", () => {
    expect(classifyHeuristic("what does main.tsx do?").difficulty).toBe("hard");
    expect(classifyHeuristic("what is `function foo`?").difficulty).toBe("hard");
  });

  it("falls back to the heuristic when no ONNX model is given", async () => {
    // The pure-TS model classifies a plain lookup as simple.
    const b = await classifyWithModel("what is a mutex?");
    expect(b.difficulty).toBe("simple");
    expect(b.confidence).toBeGreaterThan(0.5);
  });

  it("model classifies an action/code turn as hard", async () => {
    const c = await classifyWithModel("refactor the auth module and fix the tests");
    expect(c.difficulty).toBe("hard");
  });

  it("safety gate: heuristic hard signal overrides a model simple verdict", async () => {
    // A short question that mentions a code artifact — heuristic says hard.
    const c = await classifyWithModel("what does main.tsx do?");
    expect(c.difficulty).toBe("hard");
  });
});

describe("resolveTurnModel — conservative routing", () => {
  it("does not route when disabled", () => {
    const r = resolveTurnModel({
      provider: "anthropic",
      currentModel: "claude-sonnet-4-20250514",
      text: "what is a closure?",
      enabled: false,
    });
    expect(r.routed).toBe(false);
    expect(r.model).toBe("claude-sonnet-4-20250514");
  });

  it("routes a confidently-simple turn to the fast model when enabled", () => {
    const r = resolveTurnModel({
      provider: "anthropic",
      currentModel: "claude-sonnet-4-20250514",
      text: "what is a closure?",
      enabled: true,
    });
    expect(r.routed).toBe(true);
    expect(r.model).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps a hard turn on the configured model even when enabled", () => {
    const r = resolveTurnModel({
      provider: "anthropic",
      currentModel: "claude-sonnet-4-20250514",
      text: "refactor the auth module and fix the tests",
      enabled: true,
    });
    expect(r.routed).toBe(false);
    expect(r.model).toBe("claude-sonnet-4-20250514");
  });

  it("does not downgrade when already on the fast model", () => {
    const r = resolveTurnModel({
      provider: "anthropic",
      currentModel: "claude-haiku-4-5-20251001",
      text: "what is a closure?",
      enabled: true,
    });
    expect(r.routed).toBe(false);
  });

  it("does not route for providers without a fast tier (ollama)", () => {
    const r = resolveTurnModel({
      provider: "ollama",
      currentModel: "llama3.2",
      text: "what is a closure?",
      enabled: true,
    });
    expect(r.routed).toBe(false);
    expect(r.model).toBe("llama3.2");
  });

  it("respects a higher minConfidence threshold", () => {
    // A medium-length question has confidence ~0.75, below a 0.9 bar.
    const longish = "explain in plain terms how the event loop schedules callbacks and microtasks over time";
    const r = resolveTurnModel({
      provider: "anthropic",
      currentModel: "claude-sonnet-4-20250514",
      text: longish,
      enabled: true,
      minConfidence: 0.9,
    });
    expect(r.routed).toBe(false);
  });
});
