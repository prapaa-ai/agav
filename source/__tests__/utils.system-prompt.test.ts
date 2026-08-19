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
    const ctx = await refreshVolatileContext();

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