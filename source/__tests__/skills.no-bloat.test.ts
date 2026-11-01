import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let agavDir = "";
vi.mock("../config/config.js", () => ({ getAgavDir: () => agavDir }));
vi.mock("../utils/project-instructions.js", () => ({ loadProjectInstructions: async () => "" }));
vi.mock("../config/memory.js", () => ({ formatMemoriesForPrompt: async () => "" }));

// With no skill enabled the model must see nothing skill-related: no catalog in
// the system prompt and no activate_skill tool. Bundled skills ship disabled by
// default, so a fresh install is exactly this empty-skill scenario.
describe("no skill bloat when nothing is enabled", () => {
  let root: string;

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(join(tmpdir(), "agav-no-bloat-"));
    agavDir = join(root, "home");
    const project = join(root, "project");
    await mkdir(project);
    vi.spyOn(process, "cwd").mockReturnValue(project);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("loads zero active skills on a fresh install", async () => {
    const { loadSkills } = await import("../skills/loader.js");
    expect(await loadSkills()).toEqual([]);
  });

  it("emits no skill catalog or activate_skill guidance in the stable system prompt", async () => {
    const { refreshStableContext } = await import("../utils/system-prompt.js");
    const ctx = await refreshStableContext();
    expect(ctx).toBe("");
    expect(ctx).not.toMatch(/skill/i);
    expect(ctx).not.toContain("activate_skill");
  });

  it("keeps the base system prompt free of skill references", async () => {
    const { buildSystemPrompt } = await import("../utils/system-prompt.js");
    const prompt = await buildSystemPrompt();
    expect(prompt).not.toMatch(/\bskill\b/i);
    expect(prompt).not.toContain("activate_skill");
  });

  it("produces an empty catalog for an empty skill set", async () => {
    const { buildSkillCatalog } = await import("../skills/loader.js");
    expect(buildSkillCatalog([])).toBe("");
  });

  it("registers no activate_skill tool and no skill slash commands when nothing is enabled", async () => {
    const { loadSkills, getOrLoadSkills } = await import("../skills/loader.js");
    const { createSkillSlashCommand } = await import("../skills/commands.js");
    const skills = await loadSkills();
    // Mirror use-agent startup: the activate_skill tool is only built when
    // skills.length > 0, and slash commands come from the same empty set.
    expect(skills.length > 0).toBe(false);
    const commands = skills
      .filter((s) => s.frontmatter.invocation !== "agav")
      .map((s) => createSkillSlashCommand(s));
    expect(commands).toEqual([]);
    // The catalog stays empty even through the session-cache accessor.
    const { buildSkillCatalog } = await import("../skills/loader.js");
    expect(buildSkillCatalog(await getOrLoadSkills())).toBe("");
  });
});
