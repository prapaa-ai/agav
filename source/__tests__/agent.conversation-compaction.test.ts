import { describe, expect, it } from "vitest";

import { ConversationState } from "../agent/conversation.js";
import type { ContentBlock, Message } from "../providers/types.js";

/**
 * Build a conversation long and heavy enough that a forced compaction has
 * something to drop: alternating user turns, assistant tool calls, and the
 * matching tool results.
 */
function buildConversation(cycles: number): ConversationState {
  const convo = new ConversationState();
  convo.setModel("test");
  for (let i = 0; i < cycles; i++) {
    convo.addUserMessage(`question ${i} `.repeat(200));
    convo.addAssistantMessage([
      { type: "tool_use", toolCallId: `call-${i}`, toolName: "read_file", toolInput: { path: `f${i}.ts` } } as ContentBlock,
    ]);
    convo.addToolResults([
      { type: "tool_result", toolCallId: `call-${i}`, toolResult: `contents ${i} `.repeat(200) } as ContentBlock,
    ]);
  }
  return convo;
}

function textBlocks(messages: Message[]): string[] {
  return messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text ?? ""));
}

describe("conversation compaction", () => {
  // A blank summary used to be stored verbatim, and every later request failed
  // with "text content blocks must be non-empty" until the session was cleared.
  it("falls back to a placeholder when the summarizer returns nothing", async () => {
    const convo = buildConversation(8);
    const result = await convo.compactIfNeeded(true, async () => "");

    expect(result.compacted).toBe(true);
    expect(textBlocks(convo.getMessages()).some((t) => t.trim() === "")).toBe(false);
    expect(convo.lastCompactionSummary).toContain("compacted to save context");
  });

  it("falls back to a placeholder when the summarizer only returns whitespace", async () => {
    const convo = buildConversation(8);
    await convo.compactIfNeeded(true, async () => "  \n\t ");

    expect(textBlocks(convo.getMessages()).some((t) => t.trim() === "")).toBe(false);
  });

  it("falls back to a placeholder when the summarizer throws", async () => {
    const convo = buildConversation(8);
    const result = await convo.compactIfNeeded(true, async () => {
      throw new Error("Vertex AI Claude API error 400");
    });

    expect(result.compacted).toBe(true);
    expect(textBlocks(convo.getMessages()).some((t) => t.trim() === "")).toBe(false);
  });

  it("keeps a real summary when the summarizer produces one", async () => {
    const convo = buildConversation(8);
    await convo.compactIfNeeded(true, async () => "## Task\nreal summary");

    expect(convo.getMessages()[0]?.content[0]?.text).toBe("## Task\nreal summary");
  });

  // Sessions saved before the fix already carry the empty block, so loading one
  // has to repair it rather than fail the same way all over again.
  it("strips empty text blocks out of a restored session", async () => {
    const convo = new ConversationState();
    convo.setMessages([
      { role: "user", content: [{ type: "text", text: "" }] },
      { role: "user", content: [{ type: "text", text: "  " }, { type: "text", text: "real" }] },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "answer" }] },
    ] as Message[]);

    expect(convo.length).toBe(2);
    expect(textBlocks(convo.getMessages())).toEqual(["real", "answer"]);
  });

  // When the newest messages dominate the budget, the split falls back to the
  // "keep at least 4" floor — which for a tool-heavy history lands squarely on
  // a tool_result whose tool_use sits just before it.
  it("moves the boundary off a tool_result when the keep-4 floor decides it", async () => {
    // 21 messages, so the keep-4 floor lands on index 17 — a tool_result. The
    // final result is large enough that the token budget keeps nothing on its
    // own, leaving the floor to pick the boundary.
    const convo = buildConversation(6);
    convo.addUserMessage("one more");
    convo.addAssistantMessage([
      { type: "tool_use", toolCallId: "call-6", toolName: "read_file", toolInput: {} } as ContentBlock,
    ]);
    convo.addToolResults([
      { type: "tool_result", toolCallId: "call-6", toolResult: "huge ".repeat(20000) } as ContentBlock,
    ]);

    let dropped: Message[] = [];
    await convo.compactIfNeeded(true, async (msgs) => {
      dropped = msgs;
      return "summary";
    });

    // The summary is index 0; the first surviving real message must not open
    // with a tool_result, or its tool_use went out with the dropped half.
    const firstKept = convo.getMessages()[1];
    expect(firstKept?.content.some((b) => b.type === "tool_result")).toBe(false);
    expect(dropped.at(-1)?.content.some((b) => b.type === "tool_use")).toBe(false);
  });

  // Both halves of the split are used as standalone conversations, so a
  // tool_result must never be separated from the tool_use it answers.
  it("never splits a tool cycle across the compaction boundary", async () => {
    const convo = buildConversation(10);
    let dropped: Message[] = [];
    await convo.compactIfNeeded(true, async (msgs) => {
      dropped = msgs;
      return "summary";
    });

    const keptIds = new Set<string>();
    for (const msg of convo.getMessages()) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.toolCallId) keptIds.add(block.toolCallId);
      }
    }
    for (const msg of convo.getMessages()) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.toolCallId) {
          expect(keptIds.has(block.toolCallId)).toBe(true);
        }
      }
    }

    const droppedIds = new Set<string>();
    for (const msg of dropped) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.toolCallId) droppedIds.add(block.toolCallId);
      }
    }
    for (const msg of dropped) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.toolCallId) {
          expect(droppedIds.has(block.toolCallId)).toBe(true);
        }
      }
    }
    // The two halves must not both claim the same call.
    for (const id of droppedIds) expect(keptIds.has(id)).toBe(false);
  });
});
