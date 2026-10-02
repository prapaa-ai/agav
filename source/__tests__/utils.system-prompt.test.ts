import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/git.js", () => ({
  getGitContext: vi.fn(),
  formatGitPrompt: vi.fn(() => "git block"),
}));
vi.mock("../utils/project-instructions.js", () => ({
  loadProjectInstructions: vi.fn(() => "project instructions"),
}));
vi.mock("../config/memory.js", () => ({
  formatMemoriesForPrompt: vi.fn(() => "memories"),
}));
vi.mock("../skills/loader.js", () => ({
  getCachedSkills: vi.fn(() => []),
  loadSkills: vi.fn(() => [{ name: "skill-one" }]),
  buildSkillCatalog: vi.fn(() => "skills catalog"),
}));
vi.mock("../commands/steer.js", () => ({
  formatSteersForPrompt: vi.fn(() => "steers"),
}));

import {
  refreshDynamicContext,
  refreshStableContext,
  refreshVolatileContext,
  formatTurnContext,
  buildSystemPrompt,
} from "../utils/system-prompt.js";
import { formatGitPrompt, getGitContext } from "../utils/git.js";
import { loadProjectInstructions } from "../utils/project-instructions.js";
import { formatMemoriesForPrompt } from "../config/memory.js";
import { buildSkillCatalog, getCachedSkills, loadSkills } from "../skills/loader.js";
import { formatSteersForPrompt } from "../commands/steer.js";

describe("utils/system-prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the base system prompt", async () => {
    await expect(buildSystemPrompt()).resolves.toContain("Agav");
  });

  it("keeps the base prompt compact with one verification section", async () => {
    const prompt = await buildSystemPrompt();
    // Regression ceiling for the static instructions, excluding the variable cwd.
    const instructions = prompt.split("The user's current working directory is:")[0]!;
    expect(Buffer.byteLength(instructions)).toBeLessThan(5_200);
    expect(prompt.match(/^VERIFICATION:$/gm)).toHaveLength(1);
  });

  it("retains testing, manual verification, and complete error handling requirements", async () => {
    const prompt = await buildSystemPrompt();
    for (const requirement of [
      /After EVERY code edit.*relevant tests/,
      /vitest, jest, pytest, cargo test, go test/,
      /broader suite.*regressions/,
      /revise or revert/,
      /build\/compile, run, and check output/,
      /passing test output/,
      /can't RUN a test, always READ it/,
      /Without a test suite.*build\/compile → run → check output/,
      /Diff against expected output files/,
      /every specified success criterion/,
      /Read COMPLETE build and shell output, even on exit code 0/,
      /For every error or warning.*file\/line and cause/,
      /rerun until all are resolved/,
      /temp location then moving\/renaming atomically/,
    ]) expect(prompt).toMatch(requirement);
  });

  it("preserves safety rules, exploration, and the ordered bug-fixing loop", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("ONLY create or edit files inside __tests__/ or test/ directories");
    expect(prompt).toContain("The only exception is if you discover a genuine bug in the source");
    expect(prompt).toContain("When writing documentation: NEVER modify source code");
    expect(prompt).toContain("NEVER edit build output files (build/, dist/ directories)");
    expect(prompt).toContain("thoroughly explore the entire working directory");
    expect(prompt).toContain("Use `overview` first");
    expect(prompt).toContain("Use `grep_search`");
    expect(prompt).toContain("READ THEM FIRST");
    const steps = prompt.match(/^  [1-7]\) .+$/gm)!;
    expect(steps).toHaveLength(7);
    expect(steps.map((step) => step.slice(2, 4))).toEqual(["1)", "2)", "3)", "4)", "5)", "6)", "7)"]);
    expect(prompt).toContain("Use subagents when:");
    expect(prompt).toContain("If you're unsure about the right approach, say so");
  });

  it("does not load dynamic context when building the base prompt", async () => {
    const first = await buildSystemPrompt();
    const second = await buildSystemPrompt();
    expect(second).toBe(first);
    expect(first).toContain(`The user's current working directory is: ${process.cwd()}`);
    for (const load of [getGitContext, loadProjectInstructions, formatMemoriesForPrompt, getCachedSkills, loadSkills, formatSteersForPrompt]) {
      expect(load).not.toHaveBeenCalled();
    }
  });

  it("refreshes dynamic context from all sections", async () => {
    vi.mocked(getGitContext).mockResolvedValue({ isRepo: true, branch: "main", status: "clean", recentCommits: "", remoteUrl: "" });
    vi.mocked(formatGitPrompt).mockReturnValue("git block");
    const ctx = await refreshDynamicContext({ getResourceContextBlock: () => "mcp block" } as any);

    expect(formatGitPrompt).toHaveBeenCalled();
    expect(loadProjectInstructions).toHaveBeenCalled();
    expect(formatMemoriesForPrompt).toHaveBeenCalled();
    expect(getCachedSkills).toHaveBeenCalled();
    expect(loadSkills).toHaveBeenCalled();
    expect(buildSkillCatalog).toHaveBeenCalled();
    expect(formatSteersForPrompt).toHaveBeenCalled();
    expect(ctx).toContain("git block");
    expect(ctx).toContain("project instructions");
    expect(ctx).toContain("mcp block");
    expect(ctx).toContain("memories");
    expect(ctx).toContain("skills catalog");
    expect(ctx).toContain("steers");
  });

  // The split is what makes the request cacheable: anything volatile sitting in
  // the system prompt evicts the tool schemas and conversation behind it.
  it("keeps git state and steers out of the stable context", async () => {
    const ctx = await refreshStableContext({ getResourceContextBlock: () => "mcp block" } as any);

    expect(ctx).toContain("project instructions");
    expect(ctx).toContain("mcp block");
    expect(ctx).toContain("memories");
    expect(ctx).toContain("skills catalog");
    expect(ctx).not.toContain("git block");
    expect(ctx).not.toContain("steers");
    expect(getGitContext).not.toHaveBeenCalled();
    expect(formatSteersForPrompt).not.toHaveBeenCalled();
  });

  it("puts only per-turn state in the volatile context", async () => {
    vi.mocked(getGitContext).mockResolvedValue({ isRepo: true, branch: "main", status: "clean", recentCommits: "", remoteUrl: "" });
    const { context: ctx } = await refreshVolatileContext();

    expect(ctx).toContain("git block");
    expect(ctx).toContain("steers");
    expect(ctx).not.toContain("project instructions");
    expect(ctx).not.toContain("memories");
    expect(ctx).not.toContain("skills catalog");
    expect(loadProjectInstructions).not.toHaveBeenCalled();
    expect(buildSkillCatalog).not.toHaveBeenCalled();
  });

  it("marks turn context as environment state that may be stale", () => {
    const wrapped = formatTurnContext("git block");

    expect(wrapped).toContain("<environment-context>");
    expect(wrapped).toContain("</environment-context>");
    expect(wrapped).toContain("git block");
    expect(wrapped).toMatch(/stale/i);
  });
});