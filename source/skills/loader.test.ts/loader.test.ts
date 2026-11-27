import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllSkills } from "./loader.js";

vi.mock("../config/config.js", () => ({
  getAgavDir: () => mockAgavDir,
}));

let mockAgavDir = "";

const validSkill = `---
name: good-skill
description: A valid test skill.
---
Does good things.
`;

const malformedSkill = `---
name: broken-skill
description: [unclosed
---
Broken body.
`;

async function writeSkill(base: string, dirName: string, content: string): Promise<void> {
  const dir = join(base, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
}

describe("loader reports malformed skill YAML", () => {
  let tmpBase = "";
  let globalSkillsDir = "";
  let projectDir = "";

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), "agav-loader-malformed-test-"));
    globalSkillsDir = join(tmpBase, "global", "skills");
    projectDir = join(tmpBase, "project");
    await mkdir(globalSkillsDir, { recursive: true });
    await mkdir(join(projectDir, ".agav", "skills"), { recursive: true });
    mockAgavDir = join(tmpBase, "global");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpBase, { recursive: true, force: true });
  });

  it("reports a malformed-YAML skill on stderr and skips it", async () => {
    await writeSkill(globalSkillsDir, "broken-skill", malformedSkill);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const skills = await loadAllSkills();

    expect(skills.map((skill) => skill.name)).not.toContain("broken-skill");
    expect(errorSpy).toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes("broken-skill"))).toBe(true);
    expect(messages.some((message) => message.includes("SKILL.md"))).toBe(true);
    expect(messages.every((message) => !message.includes("\n"))).toBe(true);
    expect(messages.every((message) => !message.includes("Broken body."))).toBe(true);
  });

  it("still loads valid siblings next to a malformed skill", async () => {
    await writeSkill(globalSkillsDir, "broken-skill", malformedSkill);
    await writeSkill(globalSkillsDir, "good-skill", validSkill);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const skills = await loadAllSkills();

    expect(skills.map((skill) => skill.name)).toContain("good-skill");
    expect(skills.map((skill) => skill.name)).not.toContain("broken-skill");
  });

  it("stays quiet for a directory without SKILL.md", async () => {
    await mkdir(join(globalSkillsDir, "empty-skill"), { recursive: true });
    await writeSkill(globalSkillsDir, "good-skill", validSkill);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const skills = await loadAllSkills();

    expect(skills.map((skill) => skill.name)).toContain("good-skill");
    expect(skills.map((skill) => skill.name)).not.toContain("empty-skill");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
