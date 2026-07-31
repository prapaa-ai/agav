import { describe, it, expect } from "vitest";

import { getToolLabel, getToolSummary } from "../utils/tool-labels.js";

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

  it("falls back for unknown tools", () => {
    expect(getToolLabel("custom_tool")).toBe("Tool");
    expect(getToolSummary("custom_tool", { a: 1, b: 2 })).toBe("a, b");
  });
});
