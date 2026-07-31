import { describe, expect, it } from "vitest";

import { buildSkillCatalog, getCachedSkills, getSkill, parseSkillMarkdown } from "../skills/loader.js";
import type { SkillDefinition } from "../skills/types.js";

describe("skills/loader", () => {
  it("parses frontmatter with lists, booleans, quoted values, and body text", () => {
    const text = `---
name: "Test Skill"
description: 'Does useful work'
version: 1.2.3
invocation: user
allowed-tools:
  - read_file
  - write_file
disallowed-tools: [shell, web_search]
model: gpt-test
tags: [alpha, beta]
---
Body line 1
Body line 2
`;

    const parsed = parseSkillMarkdown(text);

    expect(parsed.frontmatter).toEqual({
      name: "Test Skill",
      description: "Does useful work",
      version: "1.2.3",
      invocation: "user",
      "allowed-tools": ["read_file", "write_file"],
      "disallowed-tools": ["shell", "web_search"],
      model: "gpt-test",
      effort: undefined,
      tags: ["alpha", "beta"],
    });
    expect(parsed.body).toBe("Body line 1\nBody line 2");
  });

  it("falls back when markdown has no frontmatter", () => {
    const parsed = parseSkillMarkdown("plain body");

    expect(parsed).toEqual({
      frontmatter: { name: "unknown", description: "" },
      body: "plain body",
    });
  });

  it("builds a catalog with invocation labels and cached lookups default empty", () => {
    const skills: SkillDefinition[] = [
      {
        name: "Auto Skill",
        slug: "auto-skill",
        description: "Runs automatically",
        body: "",
        filePath: "/tmp/auto",
        origin: "bundled",
        frontmatter: { name: "Auto Skill", description: "Runs automatically", invocation: "agav" },
      },
      {
        name: "Manual Skill",
        slug: "manual-skill",
        description: "Runs manually",
        body: "",
        filePath: "/tmp/manual",
        origin: "project",
        frontmatter: { name: "Manual Skill", description: "Runs manually", invocation: "user" },
      },
    ];

    const catalog = buildSkillCatalog(skills);

    expect(catalog).toContain("Available skills");
    expect(catalog).toContain("- Auto Skill: Runs automatically [auto]");
    expect(catalog).toContain("- Manual Skill: Runs manually [manual]");

    expect(getCachedSkills()).toEqual([]);
    expect(getSkill("Manual Skill")).toBeUndefined();
  });
});
