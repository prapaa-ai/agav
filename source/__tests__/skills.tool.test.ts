import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../tools/registry.js";

const reportedUsage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 };

vi.mock("../skills/loader.js", () => ({
  getSkill: vi.fn(() => ({
    name: "Nested Skill",
    slug: "nested-skill",
    description: "Runs nested",
    body: "",
    frontmatter: { name: "Nested Skill", description: "Runs nested", invocation: "agav" },
    filePath: "/tmp/skills/nested/SKILL.md",
    origin: "project",
  })),
}));
vi.mock("../skills/executor.js", () => ({
  executeSkill: vi.fn(async (_skill: unknown, _args: string, deps: { onTokenUsage?: (usage: typeof reportedUsage) => void }) => {
    deps.onTokenUsage?.(reportedUsage);
    return { output: "nested output", tokenUsage: reportedUsage };
  }),
}));

import { createSkillTool } from "../skills/tool.js";

describe("skills/tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes token usage from activate_skill runs into the parent accounting callback", async () => {
    const onTokenUsage = vi.fn();
    const tool = createSkillTool({
      provider: { name: "mock", stream: vi.fn() } as any,
      parentRegistry: new ToolRegistry(),
      getConfig: () => ({
        model: "test-model",
        systemPrompt: "",
        permissionMode: "ask",
        effort: "medium",
        maxIterations: 1,
      }),
      onTokenUsage,
      getSignal: () => undefined,
    });

    const result = await tool.execute({ name: "Nested Skill", arguments: "use this" });

    expect(result).toEqual({ output: "nested output", isError: false });
    expect(onTokenUsage).toHaveBeenCalledTimes(1);
    expect(onTokenUsage).toHaveBeenCalledWith(reportedUsage);
  });
});
