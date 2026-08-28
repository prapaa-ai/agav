import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, "shell output", "");
  }),
}));

import { execFile } from "node:child_process";

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

  describe("shell block permission gating", () => {
    const shellSkill: SkillDefinition = {
      name: "Shell Skill",
      slug: "shell-skill",
      description: "Skill with shell blocks",
      body: "Before\n```sh\necho hello\n```\nAfter",
      frontmatter: { name: "Shell Skill", description: "Skill with shell blocks" },
      filePath: "/tmp/shell/SKILL.md",
      origin: "project",
    };

    it("does not execute shell blocks in deny-writes mode", async () => {
      const result = await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "deny-writes",
      });

      expect(execFile).not.toHaveBeenCalled();
      expect(result.output).toBe("skill done");
    });

    it("does not execute shell blocks in ask mode without confirmation handler", async () => {
      const result = await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "ask",
        confirmTool: undefined,
      });

      expect(execFile).not.toHaveBeenCalled();
      expect(result.output).toBe("skill done");
    });

    it("does not execute shell blocks when user denies confirmation", async () => {
      const confirmTool = vi.fn().mockResolvedValue("no");

      const result = await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "ask",
        confirmTool,
      });

      expect(confirmTool).toHaveBeenCalledWith("skill_shell_block", { command: "echo hello" });
      expect(execFile).not.toHaveBeenCalled();
      expect(result.output).toBe("skill done");
    });

    it("executes shell blocks when user confirms", async () => {
      const confirmTool = vi.fn().mockResolvedValue("yes");

      await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "ask",
        confirmTool,
      });

      expect(confirmTool).toHaveBeenCalledWith("skill_shell_block", { command: "echo hello" });
      expect(execFile).toHaveBeenCalled();
    });

    it("executes shell blocks in auto-accept mode without confirmation", async () => {
      await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "auto-accept",
      });

      expect(execFile).toHaveBeenCalled();
    });

    it("skips remaining confirmations after user chooses 'always'", async () => {
      const multiShellSkill: SkillDefinition = {
        ...shellSkill,
        body: "A\n```sh\necho one\n```\nB\n```sh\necho two\n```\nC",
      };
      const confirmTool = vi.fn().mockResolvedValueOnce("always");

      await executeSkill(multiShellSkill, "test", {
        ...baseDeps,
        permissionMode: "ask",
        confirmTool,
      });

      // Only the first block should trigger confirmation; the second auto-accepts.
      expect(confirmTool).toHaveBeenCalledTimes(1);
      expect(execFile).toHaveBeenCalledTimes(2);
    });
  });
});
