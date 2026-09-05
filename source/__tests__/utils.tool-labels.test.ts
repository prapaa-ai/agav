import { describe, it, expect } from "vitest";

import { getToolLabel, getToolSummary, isBookkeepingTool, getMcpServerName } from "../utils/tool-labels.js";

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

  describe("MCP tool label formatting", () => {
    it("formats MCP tool names by stripping server prefix and humanizing", () => {
      expect(getToolLabel("paper__get_guide")).toBe("Get guide");
      expect(getToolLabel("mcp-web-scraper__scrape_website_tool")).toBe("Scrape website tool");
    });
  });

  describe("getMcpServerName", () => {
    it("extracts the server name from MCP tool names", () => {
      expect(getMcpServerName("paper__get_guide")).toBe("paper");
      expect(getMcpServerName("mcp-web-scraper__scrape_website_tool")).toBe("mcp-web-scraper");
    });

    it("returns undefined for non-MCP tool names", () => {
      expect(getMcpServerName("read_file")).toBeUndefined();
      expect(getMcpServerName("run_command")).toBeUndefined();
      expect(getMcpServerName("custom_tool")).toBeUndefined();
    });
  });

  describe("edge cases with double underscores", () => {
    it("uses first __ as separator when multiple __ exist", () => {
      expect(getMcpServerName("server__tool__with__underscores")).toBe("server");
      expect(getToolLabel("server__tool__with__underscores")).toBe("Tool  with  underscores");
    });

    it("returns fallback/undefined for empty string", () => {
      expect(getToolLabel("")).toBe("Tool");
      expect(getMcpServerName("")).toBeUndefined();
    });

    it("returns undefined server name when __ is leading", () => {
      expect(getMcpServerName("__leading")).toBeUndefined();
    });
  });
});
