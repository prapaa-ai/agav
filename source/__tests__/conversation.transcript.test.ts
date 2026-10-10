import { describe, expect, it } from "vitest";
import { ConversationState } from "../agent/conversation.js";
import type { Message } from "../providers/types.js";

function cycle(conversation: ConversationState, id: string, output: string) {
  conversation.addAssistantMessage([{ type: "tool_use", toolCallId: id, toolName: "read_file", toolInput: { path: "fixture" } }]);
  conversation.addToolResults([{ type: "tool_result", toolCallId: id, toolResult: output,
    toolResultContent: [{ type: "text", text: output }] }]);
}

describe("execution transcript", () => {
  it("preserves full rich tool results when trimming alone reduces context below the threshold", async () => {
    const conversation = new ConversationState(true);
    conversation.setModel("mock");
    conversation.setContextWindow(4000);
    conversation.addUserMessage("Original task");
    const output = "payload ".repeat(2000);
    cycle(conversation, "first", output);
    for (let i = 0; i < 5; i++) cycle(conversation, `recent-${i}`, "small result");
    const before = conversation.getTranscript();
    const result = await conversation.compactIfNeeded();
    expect(result.compacted).toBe(false);
    expect(conversation.getMessages()[2]!.content[0]!.toolResult).toContain("...(trimmed)");
    expect(conversation.getTranscript()).toEqual(before);
    expect(conversation.getTranscript()[2]!.content[0]!.toolResultContent).toEqual([{ type: "text", text: output }]);
  });

  it("records internal turns, appended context and injected turns in protocol-safe order", () => {
    const conversation = new ConversationState(true);
    conversation.addUserMessage("task");
    conversation.appendToLastUserMessage("environment");
    cycle(conversation, "answered", "result");
    conversation.addAssistantMessage([{ type: "tool_use", toolCallId: "pending", toolName: "read_file" }]);
    conversation.injectUserMessage("steer");
    conversation.addToolResults([{ type: "tool_result", toolCallId: "pending", toolResult: "result" }]);
    conversation.addInternalUserMessage("retry");
    expect(conversation.getTranscript()).toEqual(conversation.getMessages());
    const snapshot = conversation.getTranscript();
    snapshot[0]!.content[0]!.text = "modified";
    expect(conversation.getTranscript()[0]!.content[0]!.text).toBe("task");
  });

  it("resets recording on clear and sanitizes restored messages", () => {
    const conversation = new ConversationState(true);
    conversation.addUserMessage("old");
    conversation.clear();
    expect(conversation.getTranscript()).toEqual([]);
    conversation.setMessages([{ role: "user", content: [{ type: "text", text: "" }] },
      { role: "user", content: [{ type: "text", text: "restored" }] }] as Message[]);
    conversation.appendToLastUserMessage("context");
    expect(conversation.getTranscript()).toEqual(conversation.getMessages());
  });
});
