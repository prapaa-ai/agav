import { describe, it, expect } from "vitest";

describe("shouldAutoPlan", () => {
  it("triggers on strong keywords (score 2)", async () => {
    const { shouldAutoPlan } = await import("../agent/planner.js");
    expect(shouldAutoPlan("refactor this module")).toBe(true);
    expect(shouldAutoPlan("migrate the database")).toBe(true);
    expect(shouldAutoPlan("rewrite the auth system")).toBe(true);
  });

  it("does not trigger on medium keyword alone (score 1)", async () => {
    const { shouldAutoPlan } = await import("../agent/planner.js");
    expect(shouldAutoPlan("implement a feature")).toBe(false);
    expect(shouldAutoPlan("set up the project")).toBe(false);
  });

  it("triggers on medium keyword + multi-step language (score 2)", async () => {
    const { shouldAutoPlan } = await import("../agent/planner.js");
    expect(shouldAutoPlan("implement a feature, first do X then do Y")).toBe(true);
    expect(shouldAutoPlan("set up the project in phase 1")).toBe(true);
  });

  it("triggers on long prompt (>200 chars) + keyword (score 2)", async () => {
    const { shouldAutoPlan } = await import("../agent/planner.js");
    const longPrompt = "implement " + "a".repeat(200);
    expect(shouldAutoPlan(longPrompt)).toBe(true);
  });

  it("does not trigger on short simple prompts", async () => {
    const { shouldAutoPlan } = await import("../agent/planner.js");
    expect(shouldAutoPlan("hello world")).toBe(false);
    expect(shouldAutoPlan("fix the typo")).toBe(false);
    expect(shouldAutoPlan("add test cases")).toBe(false);
  });

  it("respects explicit opt-out", async () => {
    const { shouldAutoPlan } = await import("../agent/planner.js");
    expect(shouldAutoPlan("refactor the code, no plan")).toBe(false);
    expect(shouldAutoPlan("don't plan, just migrate it")).toBe(false);
    expect(shouldAutoPlan("skip plan and rewrite this")).toBe(false);
  });

  it("respects explicit opt-in with plan: prefix", async () => {
    const { shouldAutoPlan } = await import("../agent/planner.js");
    expect(shouldAutoPlan("plan: add a health check endpoint")).toBe(true);
    expect(shouldAutoPlan("plan - migrate to Go")).toBe(true);
  });
});
