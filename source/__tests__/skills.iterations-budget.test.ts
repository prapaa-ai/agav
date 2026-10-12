import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider, StreamEvent } from "../providers/types.js";

vi.mock("../skills/improvement.js", () => ({ recordSkillTrace: async () => {} }));

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
      body: "inspect",
      frontmatter: { name: "test-skill", description: "test", invocation: "user" },
      origin: "bundled",
      filePath: ""
    } as SkillDefinition;
    const cmd = createSkillSlashCommand(skill);
    const stream = vi.fn(() => (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", text: "done" };
    })());
    const provider: LLMProvider = { name: "mock", stream };
    const context = {
      provider, toolRegistry: new ToolRegistry(),
      config: { model: "mock", systemPrompt: "", permissionMode: "auto-accept", effort: "low", maxIterations: 1 },
      // A manual invocation is a new prompt, not a continuation of this budget.
      iterationsBudget: { remaining: 0, total: 1 },
      setRunningSkill: vi.fn(), addTokenUsage: vi.fn(),
    };
    for (const calls of [1, 2]) {
      expect(await cmd.execute("inspect", context as any)).toMatchObject({ type: "message", text: "done", _isSkill: true });
      expect(stream).toHaveBeenCalledTimes(calls);
      expect(context.iterationsBudget.remaining).toBe(0);
    }
  });
});
