import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";

vi.mock("../agent/loop.js", () => ({
  runAgentLoop: vi.fn(() => (async function* () {
    yield { type: "usage", inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 };
    yield { type: "assistant_message_complete", text: "skill done" };
  })()),
}));
vi.mock("../commands/steer.js", () => ({
  formatSteersForPrompt: vi.fn(() => ""),
}));
vi.mock("../skills/improvement.js", () => ({
  recordSkillTrace: vi.fn(() => Promise.resolve()),
}));

import { runAgentLoop } from "../agent/loop.js";
import { recordSkillTrace } from "../skills/improvement.js";
import { executeSkill } from "../skills/executor.js";

const baseDeps = {
  provider: { name: "mock", stream: vi.fn() } as any,
  parentRegistry: new ToolRegistry(),
  model: "test-model",
  systemPrompt: "",
  permissionMode: "ask" as const,
  effort: "medium" as const,
  maxIterations: 1,
};

const skill: SkillDefinition = {
  name: "Demo Skill",
  slug: "demo-skill",
  description: "Demo skill used in tests",
  body: "Do the thing.",
  frontmatter: { name: "Demo Skill", description: "Demo skill used in tests" },
  filePath: "/tmp/demo/SKILL.md",
  origin: "project",
};

describe("skills/executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards aggregated usage to the parent token accounting callback", async () => {
    const onTokenUsage = vi.fn();

    const result = await executeSkill(skill, "", {
      provider: { name: "mock", stream: vi.fn() } as any,
      parentRegistry: new ToolRegistry(),
      model: "test-model",
      systemPrompt: "",
      permissionMode: "ask",
      effort: "medium",
      maxIterations: 1,
      onTokenUsage,
    });

    expect(result.output).toBe("skill done");
    expect(result.tokenUsage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    });
    expect(onTokenUsage).toHaveBeenCalledTimes(1);
    expect(onTokenUsage).toHaveBeenCalledWith(result.tokenUsage);
  });

  it("records a successful run against the skill's trace log", async () => {
    await executeSkill(skill, "do it", baseDeps);

    expect(recordSkillTrace).toHaveBeenCalledWith("Demo Skill", "do it", 18, true);
  });

  // An abort or provider error part-way through still burned tokens, so the
  // usage callback has to fire — and the trace must not claim the run succeeded.
  it("reports partial usage and a failed trace when the loop throws", async () => {
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {
      yield { type: "usage", inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };
      throw new Error("aborted");
    })() as any);

    const onTokenUsage = vi.fn();

    await expect(executeSkill(skill, "do it", { ...baseDeps, onTokenUsage })).rejects.toThrow("aborted");

    expect(onTokenUsage).toHaveBeenCalledTimes(1);
    expect(onTokenUsage).toHaveBeenCalledWith({
      inputTokens: 5,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(recordSkillTrace).toHaveBeenCalledWith("Demo Skill", "do it", 9, false);
  });
});
