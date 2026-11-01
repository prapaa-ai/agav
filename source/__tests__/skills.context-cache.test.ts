import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let agavDir = "";
vi.mock("../config/config.js", () => ({ getAgavDir: () => agavDir }));
vi.mock("../utils/project-instructions.js", () => ({ loadProjectInstructions: async () => "" }));
vi.mock("../config/memory.js", () => ({ formatMemoriesForPrompt: async () => "" }));

describe("skill catalog session cache", () => {
  let root: string;

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(join(tmpdir(), "agav-skill-cache-"));
    agavDir = join(root, "home");
    const project = join(root, "project");
    await mkdir(project);
    vi.spyOn(process, "cwd").mockReturnValue(project);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps an initialized empty catalog unchanged after opting in until runtime reload", async () => {
    const { loadSkills, getCachedSkills, getSkill } = await import("../skills/loader.js");
    const { setSkillEnabled } = await import("../skills/skill-registry.js");
    const { refreshStableContext } = await import("../utils/system-prompt.js");
    // Startup registers no activation tool or slash commands for this snapshot.
    expect(await loadSkills()).toEqual([]);
    expect(await refreshStableContext()).toBe("");
    await setSkillEnabled("explain", true);

    expect(await refreshStableContext()).toBe("");
    expect(getCachedSkills()).toEqual([]);
    expect(getSkill("explain")).toBeUndefined();

    // Restart explicitly loads the snapshot used for both tools and catalog.
    await loadSkills();
    expect(await refreshStableContext()).toContain("- explain:");
    expect(getSkill("explain")).toBeDefined();
  });

  it("loads a never-initialized cache and retains a nonempty snapshot until reload", async () => {
    const { setSkillEnabled } = await import("../skills/skill-registry.js");
    const { refreshStableContext } = await import("../utils/system-prompt.js");
    const { loadSkills } = await import("../skills/loader.js");
    await setSkillEnabled("explain", true);
    expect(await refreshStableContext()).toContain("- explain:");

    await setSkillEnabled("explain", false);
    expect(await refreshStableContext()).toContain("- explain:");
    await loadSkills();
    expect(await refreshStableContext()).toBe("");
  });

  it("treats an empty initial lazy load as initialized", async () => {
    const { refreshStableContext } = await import("../utils/system-prompt.js");
    const { setSkillEnabled } = await import("../skills/skill-registry.js");
    expect(await refreshStableContext()).toBe("");
    await setSkillEnabled("explain", true);
    expect(await refreshStableContext()).toBe("");
  });
});
