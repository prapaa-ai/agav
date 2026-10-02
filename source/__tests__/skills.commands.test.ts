import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationState } from "../agent/conversation.js";
import type { SkillDefinition } from "../skills/types.js";

vi.mock("../skills/executor.js", () => ({
  executeSkill: vi.fn(async (_skill, _args, deps) => {
    const tokenUsage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    deps.onTokenUsage?.(tokenUsage);
    return { output: "user skill output", tokenUsage };
  }),
}));

import { executeSkill } from "../skills/executor.js";
import { createSkillSlashCommand } from "../skills/commands.js";

const skill: SkillDefinition = {
  name: "User Skill",
  slug: "user-skill",
  description: "Invoked manually",
  body: "do things",
  frontmatter: { name: "User Skill", description: "Invoked manually", invocation: "user" },
  filePath: "/tmp/skills/user/SKILL.md",
  origin: "project",
};

describe("skills/commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Manual-only skills merge usage live, just like activate_skill. Returning
  // _tokenUsage as well would add the final total again in App's saveNow path.
  it("uses live accounting without returning the total for a second merge", async () => {
    const command = createSkillSlashCommand(skill);
    const onEvent = vi.fn();
    const createSkillProgressTracker = vi.fn(() => onEvent);
    const addTokenUsage = vi.fn();

    const result = await command.execute("  trim me  ", {
      conversation: new ConversationState(),
      provider: { name: "mock", stream: vi.fn() } as any,
      toolRegistry: {} as any,
      config: {
        model: "test-model",
        systemPrompt: "",
        permissionMode: "ask",
        effort: "medium",
        maxIterations: 1,
      } as any,
      setModel: vi.fn(),
      setProvider: vi.fn(),
      setEffort: vi.fn(),
      clearMessages: vi.fn(),
      refreshPlan: vi.fn(),
      showStatus: vi.fn(),
      saveSession: vi.fn(),
      refreshDisplay: vi.fn(),
      loadSession: vi.fn(),
      activateSession: vi.fn(),
      renameSession: vi.fn(),
      exit: vi.fn(),
      getDebugState: vi.fn(),
      submit: vi.fn(),
      handleSubmit: vi.fn(),
      addTokenUsage,
      setRunningSkill: vi.fn(),
      createSkillProgressTracker,
      setPickerActive: vi.fn(),
      suspendTerminal: vi.fn(() => vi.fn()),
      showAgentsTUI: vi.fn(),
      showSkillsTUI: vi.fn(),
    });

    const [, passedArgs, deps] = vi.mocked(executeSkill).mock.calls[0]!;
    expect(passedArgs).toBe("trim me");
    expect(deps.onTokenUsage).toBe(addTokenUsage);
    expect(addTokenUsage).toHaveBeenCalledTimes(1);
    expect(addTokenUsage).toHaveBeenCalledWith({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    expect(createSkillProgressTracker).toHaveBeenCalledWith("User Skill", "trim me");
    expect(deps.onEvent).toBe(onEvent);

    expect(result).not.toHaveProperty("_tokenUsage");
    expect(result).toMatchObject({
      type: "message",
      text: "user skill output",
      _isSkill: true,
    });

    // A failed manual-only run must still persist the partial live usage via
    // App's _isSkill/saveNow path, without handing it a second usage total.
    vi.mocked(executeSkill).mockImplementationOnce(async (_skill, _args, deps) => {
      deps.onTokenUsage?.({ inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
      throw new Error("Aborted");
    });
    const failed = await command.execute("", {
      provider: { name: "mock", stream: vi.fn() },
      toolRegistry: {},
      config: { model: "test-model", permissionMode: "ask", effort: "medium", maxIterations: 1 },
      setRunningSkill: vi.fn(),
      addTokenUsage,
    } as any);
    expect(addTokenUsage).toHaveBeenCalledTimes(2);
    expect(addTokenUsage).toHaveBeenLastCalledWith({ inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(failed).toMatchObject({ type: "message", text: 'Skill "User Skill" failed: Aborted', _isSkill: true });
    expect(failed).not.toHaveProperty("_tokenUsage");
  });
});
