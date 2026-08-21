import { describe, it, expect } from "vitest";

import { getToolLabel, getToolSummary, isBookkeepingTool } from "../utils/tool-labels.js";

describe("utils/tool-labels", () => {
  it("returns known labels", () => {
    expect(getToolLabel("read_file")).toBe("Read File");
    expect(getToolLabel("run_command")).toBe("Shell");
  });

  it("formats summaries for common tools", () => {
    expect(getToolSummary("run_command", { command: "echo hello" })).toBe("echo hello");
    expect(getToolSummary("run_command", { command: "x".repeat(61) })).toMatch(/\.\.\.$/);
    expect(getToolSummary("grep_search", { pattern: "foo", include: "*.ts" })).toBe("foo (*.ts)");
    expect(getToolSummary("subagent", { title: "Task" })).toBe("Task");
    expect(getToolSummary("subagent", { task: "x".repeat(80) })).toMatch(/\.\.\.$/);
  });

  // update_plan only ticks a step in .agav/plans, but "Update Plan step 3 →
  // in_progress" reads as the agent rewriting its plan and losing the thread.
  it("describes a plan tick as progress rather than as a change of plan", () => {
    expect(getToolLabel("update_plan")).toBe("Plan Progress");
    expect(getToolSummary("update_plan", { step: 3, status: "done" })).toBe("step 3 complete");
    expect(getToolSummary("update_plan", { step: 3, status: "in_progress" })).toBe("starting step 3");
    expect(getToolSummary("update_plan", { step: 3, status: "failed" })).toBe("step 3 failed");
  });

  // Drives the muted styling: a progress tick must not carry the same weight as
  // an edit or a shell command.
  it("marks only progress-recording tools as bookkeeping", () => {
    expect(isBookkeepingTool("update_plan")).toBe(true);
    expect(isBookkeepingTool("edit_file")).toBe(false);
    expect(isBookkeepingTool("custom_tool")).toBe(false);
  });

  it("falls back for unknown tools", () => {
    expect(getToolLabel("custom_tool")).toBe("Tool");
    expect(getToolSummary("custom_tool", { a: 1, b: 2 })).toBe("a, b");
  });
});
