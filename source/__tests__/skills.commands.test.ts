import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationState } from "../agent/conversation.js";
import type { SkillDefinition } from "../skills/types.js";

vi.mock("../skills/executor.js", () => ({
  executeSkill: vi.fn(async () => ({
    output: "user skill output",
    tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  })),
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

  // executeSkill reports usage two mutually exclusive ways: the onTokenUsage
  // callback (activate_skill) or the returned tokenUsage (here, forwarded as
  // _tokenUsage and merged by saveNow). Wiring up both would count every
  // /skill-name run twice, so this path must leave the callback unset.
  it("keeps the slash-command skill path on returned token usage instead of the callback", async () => {
    const command = createSkillSlashCommand(skill);

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
      addTokenUsage: vi.fn(),
      setRunningSkill: vi.fn(),
      setPickerActive: vi.fn(),
      showAgentsTUI: vi.fn(),
    });

    const [, passedArgs, deps] = vi.mocked(executeSkill).mock.calls[0]!;
    expect(passedArgs).toBe("trim me");
    expect(deps.onTokenUsage).toBeUndefined();

    // The other half of the invariant: usage still has to reach the caller.
    expect(result).toMatchObject({
      type: "message",
      text: "user skill output",
      _isSkill: true,
      _tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    });
  });
});
