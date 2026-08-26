import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/tokens.js", () => ({
  estimateConversationTokens: vi.fn(() => 100),
  estimateMessageTokens: vi.fn(() => 25),
  getContextLimits: vi.fn(() => ({ warningThreshold: 90, maxTokens: 200 })),
}));

describe("confirmation queue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues confirmations and enables auto-accept after always", async () => {
    const { ConfirmationQueue } = await import("../agent/confirmation-queue.js");
    const queue = new ConfirmationQueue();
    const pending: any[] = [];
    queue.bind((item) => pending.push(item));

    const first = queue.enqueue({ toolName: "edit_file", input: {} });
    expect(pending).toHaveLength(1);
    const second = queue.enqueue({ toolName: "run_command", input: {} });
    expect(pending).toHaveLength(1);

    queue.resolve("always");
    await expect(first).resolves.toBe("always");
    await expect(second).resolves.toBe("always");
    await expect(queue.enqueue({ toolName: "run_command", input: {} })).resolves.toBe("always");
  });
});

describe("conversation state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds messages, sanitizes tool results, and compacts", async () => {
    const { ConversationState } = await import("../agent/conversation.js");
    const convo = new ConversationState();
    convo.setModel("test");
    convo.addAssistantMessage([{ type: "tool_use", toolCallId: "abc", name: "x", input: {} } as any]);
    convo.addUserMessage("hello", [{ type: "tool_result", toolCallId: "abc", content: [] } as any]);
    convo.addUserMessage("keep");

    convo.setMessages(convo.getMessages());
    expect(convo.length).toBe(3);
    await expect(convo.compactIfNeeded(true, async () => "summary")).resolves.toMatchObject({ compacted: false });
    expect(convo.wasCompacted).toBe(false);
    expect(convo.lastCompactionSummary).toBe("");
  });

  // Per-turn environment context rides at the tail of the user message so the
  // prefix ahead of it stays byte-identical and stays cacheable.
  it("appends turn context to the newest user message", async () => {
    const { ConversationState } = await import("../agent/conversation.js");
    const convo = new ConversationState();
    convo.addUserMessage("first");
    convo.addUserMessage("second");
    convo.appendToLastUserMessage("env block");

    const messages = convo.getMessages();
    expect(messages[0]!.content).toHaveLength(1);
    expect(messages[1]!.content).toEqual([
      { type: "text", text: "second" },
      { type: "text", text: "env block" },
    ]);
  });

  it("ignores empty turn context and non-user tail messages", async () => {
    const { ConversationState } = await import("../agent/conversation.js");
    const convo = new ConversationState();
    convo.addUserMessage("hi");
    convo.appendToLastUserMessage("");
    expect(convo.getMessages()[0]!.content).toHaveLength(1);

    convo.addAssistantMessage([{ type: "text", text: "reply" }]);
    convo.appendToLastUserMessage("env block");
    expect(convo.getMessages().at(-1)!.content).toEqual([{ type: "text", text: "reply" }]);

    const empty = new ConversationState();
    expect(() => empty.appendToLastUserMessage("env block")).not.toThrow();
  });
});

describe("hooks", () => {
  it("maps hook commands for edits and shell commands", async () => {
    const { getHookForTool, runHook } = await import("../agent/hooks.js");
    expect(getHookForTool("edit_file", { path: "a" }, { afterEdit: "echo $path" })).toMatchObject({ hook: "echo $path" });
    expect(getHookForTool("run_command", { command: "git commit -m hi" }, { preCommit: "echo pre" })).toMatchObject({ hook: "echo pre" });
    expect(getHookForTool("run_command", { command: "ls" }, { afterShell: "echo shell" })).toMatchObject({ hook: "echo shell" });
    const hookCmd = process.platform === "win32" ? "echo hello" : "printf hello";
    expect(await runHook(hookCmd, {})).toBe("hello");
  });
});

describe("planner", () => {
  it("formats and detects planning input", async () => {
    const mod = await import("../agent/planner.js");
    expect(mod.shouldAutoPlan("refactor the auth module")).toBe(true);
    expect(mod.shouldAutoPlan("short chat")).toBe(false);
    const formatted = mod.formatPlanForPrompt({ goal: "g", currentStep: 1, createdAt: "now", steps: [{ id: 1, title: "A", description: "B", status: "done" }] });
    expect(formatted).toContain("ACTIVE PLAN: g");
    expect(formatted).toContain("[DONE] Step 1");
  });
});
