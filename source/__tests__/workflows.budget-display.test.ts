import { describe, expect, it } from "vitest";
import { formatNodeBudget, NO_TOKEN_BUDGET } from "../workflows/metrics.js";
import type { WorkflowNodeRun } from "../workflows/types.js";

function node(partial: Partial<WorkflowNodeRun>): WorkflowNodeRun {
  return { id: "n", type: "agent", status: "passed", attempt: 1, nodeHash: "h", ...partial };
}

describe("formatNodeBudget", () => {
  it("shows a reported token budget", () => {
    expect(formatNodeBudget(node({
      tokenBudget: { limit: 5000, used: 160, remaining: 4840, period: "run" },
    }))).toBe("limit 5000, used 160, remaining 4840 (run)");
  });

  it("shows a partial budget without inventing missing fields", () => {
    expect(formatNodeBudget(node({ tokenBudget: { limit: 100 } }))).toBe("limit 100");
    expect(formatNodeBudget(node({ tokenBudget: { remaining: 5 } }))).toBe("remaining 5");
  });

  it("highlights an external agent that returned no budget", () => {
    const result = formatNodeBudget(node({ usageReported: false }));
    expect(result).toBe(`! ${NO_TOKEN_BUDGET}`);
  });

  it("shows measured token counts when usage was reported", () => {
    expect(formatNodeBudget(node({
      usageReported: true,
      usage: { inputTokens: 55, outputTokens: 5 },
    }))).toBe("60 tok");
  });

  it("prefers a reported budget over raw usage counts", () => {
    expect(formatNodeBudget(node({
      usage: { inputTokens: 10, outputTokens: 2 },
      tokenBudget: { limit: 100, used: 12 },
    }))).toBe("limit 100, used 12");
  });

  it("does not flag in-process nodes with no budget concept", () => {
    // A tool node has no external budget to report, so it shows nothing.
    expect(formatNodeBudget(node({ type: "tool" }))).toBe("");
    expect(formatNodeBudget(node({ type: "approval" }))).toBe("");
  });

  it("marks the no-budget state for non-agent external nodes too", () => {
    expect(formatNodeBudget(node({ type: "skill", usageReported: false }))).toBe(NO_TOKEN_BUDGET);
  });

  it("treats a missing usage as zero tokens rather than a warning", () => {
    expect(formatNodeBudget(node({ usage: { inputTokens: 0, outputTokens: 0 } }))).toBe("0 tok");
  });
});
