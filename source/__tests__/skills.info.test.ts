import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let agavDir = "";
vi.mock("../config/config.js", () => ({
  getAgavDir: () => agavDir,
}));

import type { CommandContext } from "../commands/types.js";
import { skillsCommand } from "../skills/commands.js";
import { loadSkills } from "../skills/loader.js";
import { setSkillEnabled } from "../skills/skill-registry.js";

const context = {} as CommandContext;

describe("/skills info", () => {
  let tmpBase: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), "agav-skills-info-"));
    agavDir = join(tmpBase, "global");
    projectDir = join(tmpBase, "project");
    await mkdir(join(agavDir, "skills"), { recursive: true });
    await mkdir(join(projectDir, ".agav", "skills"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    // Populate the real runtime cache, which excludes default-disabled skills.
    await loadSkills();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("shows default-disabled bundled metadata, including parsed tools", async () => {
    const result = await skillsCommand.execute("info explain", context);

    expect(result).toMatchObject({
      type: "message",
      text: expect.stringContaining("Name: explain\nDescription: Explain code in plain language"),
    });
    expect(result).toHaveProperty("text", expect.stringContaining("Version: 1.0.0\nInvocation: both\nOrigin: bundled"));
    expect(result).toHaveProperty("text", expect.stringContaining("Tags: understanding, documentation"));
    expect(result).toHaveProperty("text", expect.stringContaining("Allowed tools: read_file, grep_search, find_files, list_directory\nDisallowed tools: none"));
    expect(result).toHaveProperty("text", expect.stringContaining("Usage: 0 runs · 0 avg tokens · 0% success\nPath:"));
    expect(result).toHaveProperty("text", expect.stringContaining(join("bundled", "explain", "SKILL.md")));
  });

  it("still shows an explicitly enabled bundled skill", async () => {
    await setSkillEnabled("explain", true);
    expect((await loadSkills()).some((skill) => skill.slug === "explain")).toBe(true);

    expect(await skillsCommand.execute("info explain", context)).toMatchObject({
      type: "message",
      text: expect.stringContaining("Origin: bundled"),
    });
  });

  it.each(["global-helper", "Global Helper"])("finds a global skill by normalized name %s without a cache refresh", async (name) => {
    const dir = join(agavDir, "skills", "global-helper");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---
name: global-helper
description: A global helper
allowed-tools: [read_file, grep_search]
disallowed-tools: [write_file]
---
Explain the requested files.
`);

    const result = await skillsCommand.execute(`info ${name}`, context);
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("Name: global-helper") });
    expect(result).toHaveProperty("text", expect.stringContaining("Origin: global"));
    expect(result).toHaveProperty("text", expect.stringContaining("Allowed tools: read_file, grep_search\nDisallowed tools: write_file"));
    expect(result).toHaveProperty("text", expect.stringContaining(`Path: ${join(dir, "SKILL.md")}`));
  });

  it("shows an explicitly disabled project skill", async () => {
    const dir = join(projectDir, ".agav", "skills", "project-helper");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: project-helper\ndescription: A project helper\n---\nExplain the project.\n");
    await setSkillEnabled("project-helper", false);
    expect((await loadSkills()).some((skill) => skill.slug === "project-helper")).toBe(false);

    const result = await skillsCommand.execute("info project-helper", context);
    expect(result).toMatchObject({ type: "message", text: expect.stringContaining("Name: project-helper") });
    expect(result).toHaveProperty("text", expect.stringContaining("Origin: project"));
  });

  it("reports an unknown skill", async () => {
    expect(await skillsCommand.execute("info nonexistent-helper", context)).toEqual({
      type: "message",
      text: 'Skill "nonexistent-helper" not found.',
    });
  });

  it.each(["info", "info   "])("shows usage for a missing name: %s", async (args) => {
    expect(await skillsCommand.execute(args, context)).toEqual({
      type: "message",
      text: "Usage: /skills info <name>",
    });
  });
});
