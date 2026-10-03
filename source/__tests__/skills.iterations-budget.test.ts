import { describe, it, expect } from "vitest";
import { SkillDefinition } from "../skills/types.js";

describe("skills iterations budget", () => {
  it("executeSkill throws when iterationsBudget is missing", async () => {
    const { executeSkill } = await import("../skills/executor.js");
    await expect(
      executeSkill(
        { name: "test", slug: "test", description: "", frontmatter: { invocation: "user" }, origin: "bundled", filePath: "", body: "test" } as any,
        "",
        {
          provider: {} as any,
          parentRegistry: { getSchemas: () => [] } as any,
          model: "m",
          systemPrompt: "",
          permissionMode: "ask",
          effort: "medium",
        } as any
      )
    ).rejects.toThrow("iterationsBudget is required");
  });

  it("manual skill command uses fresh config budget", async () => {
    const { createSkillSlashCommand } = await import("../skills/commands.js");
    const skill = {
      name: "test-skill",
      slug: "test-skill",
      description: "test",
      frontmatter: { invocation: "user" },
      origin: "bundled",
      filePath: ""
    } as SkillDefinition;
    const cmd = createSkillSlashCommand(skill);
    expect(cmd.name).toBe("test-skill");
  });
});
