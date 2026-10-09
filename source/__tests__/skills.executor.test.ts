import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillDefinition } from "../skills/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import { ConversationState } from "../agent/conversation.js";
import { estimateConversationTokens } from "../utils/tokens.js";

vi.mock("../utils/sandbox.js", () => ({
  runInSandbox: vi.fn(async () => ({ stdout: "shell output", stderr: "", error: null, backend: "none" })),
}));

import { runInSandbox } from "../utils/sandbox.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";

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
  iterationsBudget: {remaining : 1,total : 1},
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

  it.each([
    { allowed: undefined, disallowed: undefined, expected: [] },
    { allowed: ["github", "NotebookRead", "NotebookEdit", "lsp_query"], disallowed: undefined, expected: ["lsp_query", "read_notebook", "edit_notebook", "github"] },
    { allowed: ["github", "NotebookRead"], disallowed: ["NotebookRead", "github"], expected: [] },
  ])("only adds explicitly allowed optional tools (%#)", async ({ allowed, disallowed, expected }) => {
    const parent = createToolRegistry();
    const originalNames = parent.getSchemas().map((tool) => tool.name);
    await executeSkill({ ...skill, frontmatter: {
      ...skill.frontmatter, "allowed-tools": allowed, "disallowed-tools": disallowed,
    } }, "", { ...baseDeps, parentRegistry: parent });
    const child = vi.mocked(runAgentLoop).mock.calls[0]![0].toolRegistry;
    const optional = new Set(["github", "read_notebook", "edit_notebook", "lsp_query"]);
    expect(child.getSchemas().map((tool) => tool.name).filter((name) => optional.has(name))).toEqual(expected);
    expect(parent.getSchemas().map((tool) => tool.name)).toEqual(originalNames);
  });

  it("preserves parent overrides for explicitly allowed optional tools", async () => {
    const parent = new ToolRegistry();
    const override = { schema: { name: "github", description: "override", inputSchema: { type: "object" } }, execute: vi.fn() };
    parent.register(override);
    await executeSkill({ ...skill, frontmatter: { ...skill.frontmatter, "allowed-tools": ["github"] } }, "", {
      ...baseDeps, parentRegistry: parent,
    });
    expect(vi.mocked(runAgentLoop).mock.calls[0]![0].toolRegistry.list()).toEqual([override]);
  });

  it("isolates parent blocks and token cache from child compaction", async () => {
    const parent = new ConversationState();
    for (let i = 0; i < 5; i++) {
      parent.addUserMessage(`question ${i}`);
      parent.addAssistantMessage([{
        type: "tool_use", toolCallId: `read-${i}`, toolName: "read_file",
        toolInput: { path: `file-${i}` }, providerMetadata: { nested: { signature: "original" } },
      }]);
      parent.addToolResults([{
        type: "tool_result", toolCallId: `read-${i}`, toolResult: "contents ".repeat(200),
        toolResultContent: [{ type: "text", text: "original rich result ".repeat(200) }],
      }]);
    }
    const snapshot = structuredClone(parent.getMessages());
    const cachedTokens = parent.tokenCount;
    vi.mocked(runAgentLoop).mockImplementationOnce(({ conversation }) => (async function* () {
      const childBlocks = conversation.getMessages().flatMap(message => message.content);
      const parentBlocks = parent.getMessages().flatMap(message => message.content);
      expect(childBlocks[1]?.toolInput).not.toBe(parentBlocks[1]?.toolInput);
      expect(childBlocks[1]?.providerMetadata).not.toBe(parentBlocks[1]?.providerMetadata);
      expect(childBlocks[2]?.toolResultContent).not.toBe(parentBlocks[2]?.toolResultContent);
      conversation.setContextWindow(1000);
      await conversation.compactIfNeeded(true);
      // Prove the real trimming path ran, not just a history replacement.
      expect(childBlocks[2]?.toolResult).toContain("...(trimmed)");
      expect(childBlocks[2]?.toolResultContent).toBeUndefined();
      yield { type: "turn_complete" };
    })());

    await executeSkill(skill, "", { ...baseDeps, contextMessages: parent.getMessages() });

    expect(parent.getMessages()).toEqual(snapshot);
    expect(parent.tokenCount).toBe(cachedTokens);
    expect(estimateConversationTokens(parent.getMessages())).toBe(cachedTokens);
  });

  it("compacts inherited context using the effective smaller model", async () => {
    const parent = new ConversationState();
    for (let i = 0; i < 12; i++) parent.addUserMessage("history ".repeat(12_000));
    parent.setModel("claude-sonnet-4-6");
    expect((await parent.compactIfNeeded()).compacted).toBe(false);
    const snapshot = structuredClone(parent.getMessages());
    vi.mocked(runAgentLoop).mockImplementationOnce(({ conversation, model }) => (async function* () {
      expect(model).toBe("claude-haiku-4-5");
      expect((await conversation.compactIfNeeded()).compacted).toBe(true);
      expect(conversation.tokenCount).toBeLessThan(parent.tokenCount);
      yield { type: "turn_complete" };
    })());
    await executeSkill({ ...skill, frontmatter: { ...skill.frontmatter, model: "claude-haiku-4-5" } }, "", {
      ...baseDeps, model: "claude-sonnet-4-6", contextMessages: parent.getMessages(),
    });
    expect(parent.getMessages()).toEqual(snapshot);
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
      iterationsBudget: {remaining : 1,total : 1},
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

  it("reports each usage delta before completion without adding the final total again", async () => {
    const onTokenUsage = vi.fn();
    const first = { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 };
    const second = { inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {
      yield { type: "usage", ...first };
      expect(onTokenUsage).toHaveBeenCalledTimes(1);
      expect(onTokenUsage).toHaveBeenCalledWith(first);
      yield { type: "usage", inputTokens: 5, outputTokens: 4 };
      expect(onTokenUsage).toHaveBeenLastCalledWith(second);
      yield { type: "turn_complete" };
    })() as any);
    const result = await executeSkill(skill, "", { ...baseDeps, onTokenUsage });
    expect(onTokenUsage).toHaveBeenCalledTimes(2);
    expect(result.tokenUsage).toEqual({ inputTokens: 16, outputTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2 });
  });

  it("preserves partial usage and fails on an emitted cancellation/provider error", async () => {
    const onTokenUsage = vi.fn();
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {
      yield { type: "usage", inputTokens: 5, outputTokens: 4 };
      yield { type: "error", error: new Error("Aborted") };
    })() as any);
    await expect(executeSkill(skill, "", { ...baseDeps, onTokenUsage })).rejects.toThrow("Aborted");
    expect(onTokenUsage).toHaveBeenCalledTimes(1);
    expect(onTokenUsage).toHaveBeenCalledWith({ inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(recordSkillTrace).toHaveBeenCalledWith("Demo Skill", "", 9, false);
  });

  it("adds concurrent skill deltas independently, including a failed invocation", async () => {
    let total = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 };
    const onTokenUsage = vi.fn((delta: typeof total) => {
      total = {
        inputTokens: total.inputTokens + delta.inputTokens,
        outputTokens: total.outputTokens + delta.outputTokens,
        cacheReadTokens: total.cacheReadTokens + delta.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + delta.cacheWriteTokens,
      };
    });
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {
      yield { type: "usage", inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 };
      await Promise.resolve();
      yield { type: "turn_complete" };
    })() as any);
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {
      yield { type: "usage", inputTokens: 5, outputTokens: 4 };
      yield { type: "error", error: new Error("Aborted") };
    })() as any);
    const results = await Promise.allSettled([
      executeSkill(skill, "one", { ...baseDeps, onTokenUsage }),
      executeSkill(skill, "two", { ...baseDeps, onTokenUsage }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(onTokenUsage).toHaveBeenCalledTimes(2);
    expect(total).toEqual({ inputTokens: 116, outputTokens: 61, cacheReadTokens: 23, cacheWriteTokens: 12 });
  });

  it("forwards intermediate activity before the skill finishes", async () => {
    const events = [
      { type: "thinking", text: "Inspecting the project" },
      { type: "streaming_text", text: "Reading files" },
      { type: "tool_call_start", toolName: "read_file", toolCallId: "call-1" },
      { type: "tool_result", toolName: "read_file", toolCallId: "call-1", output: "contents", isError: false },
      { type: "assistant_message_complete", text: "done" },
      { type: "turn_complete" },
    ];
    const onEvent = vi.fn();
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {
      for (const event of events) {
        yield event;
        expect(onEvent).toHaveBeenLastCalledWith(event);
      }
    })() as any);

    const result = await executeSkill(skill, "do it", { ...baseDeps, onEvent } as any);

    expect(result.output).toBe("done");
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events);
  });

  it("terminates progress when the child loop throws", async () => {
    const error = new Error("provider failed");
    vi.mocked(runAgentLoop).mockReturnValueOnce((async function* () {
      yield { type: "streaming_text", text: "working" };
      throw error;
    })() as any);
    const onEvent = vi.fn();

    await expect(executeSkill(skill, "", { ...baseDeps, onEvent } as any)).rejects.toThrow(error);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "error", error });
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

    it.each(["no", "yes", "always"] as const)("stops after cancellation at confirmation even when resolved %s", async (choice) => {
      const controller = new AbortController();
      const queue = new ConfirmationQueue();
      const confirmTool = vi.fn((toolName, input) => queue.enqueue({ toolName, input }));
      const onEvent = vi.fn();
      const pending = executeSkill({ ...shellSkill, body: shellSkill.body + "\n```sh\necho second\n```" }, "", {
        ...baseDeps, signal: controller.signal, confirmTool, onEvent,
      });
      await vi.waitFor(() => expect(confirmTool).toHaveBeenCalledTimes(1));
      controller.abort();
      if (choice === "no") queue.clear();
      else queue.resolve(choice);
      await expect(pending).rejects.toThrow("Aborted");
      expect(confirmTool).toHaveBeenCalledTimes(1);
      expect(runInSandbox).not.toHaveBeenCalled();
      expect(runAgentLoop).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenLastCalledWith({ type: "error", error: expect.any(Error) });
      expect(recordSkillTrace).toHaveBeenCalledWith("Shell Skill", "", 0, false);
    });

    it("does not prompt or execute an already cancelled skill", async () => {
      const controller = new AbortController();
      controller.abort();
      const confirmTool = vi.fn();
      await expect(executeSkill(shellSkill, "", { ...baseDeps, signal: controller.signal, confirmTool })).rejects.toThrow("Aborted");
      expect(confirmTool).not.toHaveBeenCalled();
      expect(runInSandbox).not.toHaveBeenCalled();
      expect(runAgentLoop).not.toHaveBeenCalled();
    });

    it("checks cancellation after shell completion before the next block", async () => {
      const controller = new AbortController();
      vi.mocked(runInSandbox).mockImplementationOnce(async (opts) => {
        expect(opts.signal).toBe(controller.signal);
        controller.abort();
        return { stdout: "partial", stderr: "", error: null, backend: "none" };
      });
      const onEvent = vi.fn();
      await expect(executeSkill({ ...shellSkill, body: shellSkill.body + "\n```sh\necho second\n```" }, "", {
        ...baseDeps, permissionMode: "auto-accept", signal: controller.signal, onEvent,
      })).rejects.toThrow("Aborted");
      expect(runInSandbox).toHaveBeenCalledTimes(1);
      expect(runAgentLoop).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenLastCalledWith({ type: "error", error: expect.any(Error) });
    });

    it("does not execute shell blocks in deny-writes mode", async () => {
      const result = await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "deny-writes",
      });

      expect(runInSandbox).not.toHaveBeenCalled();
      expect(result.output).toBe("skill done");
    });

    it("does not execute shell blocks in ask mode without confirmation handler", async () => {
      const result = await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "ask",
        confirmTool: undefined,
      });

      expect(runInSandbox).not.toHaveBeenCalled();
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
      expect(runInSandbox).not.toHaveBeenCalled();
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
      expect(runInSandbox).toHaveBeenCalledWith(expect.not.objectContaining({ forceBackend: "none" }));
      expect(vi.mocked(runInSandbox).mock.calls[0]?.[0]).not.toHaveProperty("inheritEnv");
    });

    it("fails the skill when its shell sandbox fails instead of ignoring the error", async () => {
      vi.mocked(runInSandbox).mockResolvedValueOnce({ stdout: "", stderr: "", error: new Error("sandbox unavailable"), backend: "seatbelt" });
      await expect(executeSkill(shellSkill, "", { ...baseDeps, permissionMode: "auto-accept" })).rejects.toThrow("sandbox unavailable");
      expect(runAgentLoop).not.toHaveBeenCalled();
      expect(recordSkillTrace).toHaveBeenCalledWith("Shell Skill", "", 0, false);
    });

    it("executes shell blocks in auto-accept mode without confirmation", async () => {
      await executeSkill(shellSkill, "test", {
        ...baseDeps,
        permissionMode: "auto-accept",
      });

      expect(runInSandbox).toHaveBeenCalled();
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
      expect(runInSandbox).toHaveBeenCalledTimes(2);
    });
  });
});
