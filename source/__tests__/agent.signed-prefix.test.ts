import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../config/config.js";
import { loadSession, saveSession } from "../config/history.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ContentBlock, LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";
import { thinkingBlocks } from "./helpers/claude-thinking.js";

const signed = () => structuredClone(thinkingBlocks) as ContentBlock[];
const hasThinking = (messages: StreamParams["messages"]) => messages.some(m => m.content.some(b => b.type === "thinking" || b.type === "redacted_thinking"));
async function drain(params: Parameters<typeof runAgentLoop>[0]) {
  const events: AgentEvent[] = [];
  for await (const event of runAgentLoop(params)) events.push(event);
  return events;
}
function fixture() {
  const conversation = new ConversationState(true);
  conversation.setModel("mock");
  conversation.addUserMessage("task");
  const tools = new ToolRegistry();
  tools.register({ schema: { name: "read_file", description: "read", inputSchema: { type: "object" } }, execute: async () => ({ output: "ok", isError: false }) });
  const requests: StreamParams[] = [];
  const provider: LLMProvider = { name: "mock", stream: vi.fn((params: StreamParams) => (async function* (): AsyncGenerator<StreamEvent> {
    requests.push(structuredClone({ ...params, signal: undefined }));
    yield { type: "thinking_block", block: signed()[0]! };
    yield { type: "text_delta", text: "answer" };
  })()) };
  const run = (systemPrompt = "instructions", model = "mock") => drain({ provider, conversation, toolRegistry: tools, model, systemPrompt, iterationsBudget: { total: 5, remaining: 5 } });
  return { conversation, tools, provider, requests, run };
}

describe("signed tool-round boundaries", () => {
  it.each(["summary", "failure", "blank", "placeholder", "trim-only"])("defers %s compaction including a steer after tool results", async mode => {
    const { conversation } = fixture();
    conversation.setContextWindow(1000);
    for (let i = 0; i < 10; i++) {
      if (mode !== "trim-only") conversation.addUserMessage("question ".repeat(200));
      conversation.addAssistantMessage([...signed(), { type: "tool_use", toolCallId: `${i}`, toolName: "read_file", toolInput: {} }]);
      conversation.addToolResults([{ type: "tool_result", toolCallId: `${i}`, toolResult: mode === "trim-only" && i === 0 ? "large ".repeat(10000) : "small result" }]);
    }
    conversation.addInternalUserMessage("steer");
    conversation.addAssistantMessage(signed());
    const before = structuredClone(conversation.getMessages());
    const summarize = vi.fn(async () => { if (mode === "failure") throw Error("offline"); return mode === "blank" ? " " : "summary"; });
    expect(await conversation.compactIfNeeded(mode !== "trim-only", mode === "placeholder" ? undefined : summarize)).toEqual({ compacted: false, droppedCount: 0 });
    expect(conversation.getMessages()).toEqual(before);
    expect(summarize).not.toHaveBeenCalled();
    conversation.addAssistantMessage([{ type: "text", text: "done" }]);
    const result = await conversation.compactIfNeeded(mode !== "trim-only", mode === "placeholder" ? undefined : summarize);
    if (mode === "trim-only") {
      expect(result.compacted).toBe(false);
      expect(conversation.getMessages()[2]!.content[0]!.toolResult).toContain("...(trimmed)");
      expect(hasThinking(conversation.getMessages())).toBe(false);
      return;
    }
    expect(result.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(mode === "placeholder" ? 0 : 1);
    expect(conversation.lastCompactionSummary).toContain(["failure", "blank", "placeholder"].includes(mode) ? "compacted to save context" : "summary");
    expect(hasThinking(conversation.getMessages())).toBe(false);
  });

  it("preserves the exact prefix in the actual loop when tools grow the context past threshold", async () => {
    const f = fixture();
    f.conversation.setContextWindow(1000);
    for (let i = 0; i < 6; i++) {
      f.conversation.addUserMessage("old question");
      f.conversation.addAssistantMessage([{ type: "text", text: "old answer" }]);
    }
    const prefix = structuredClone(f.conversation.getMessages());
    let calls = 0;
    f.provider.stream = (params) => (async function* (): AsyncGenerator<StreamEvent> {
      f.requests.push(structuredClone({ ...params, signal: undefined }));
      if (calls++ === 0) {
        for (const block of signed()) yield { type: "thinking_block", block };
        yield { type: "tool_call_start", toolCallId: "c", toolName: "read_file" };
        yield { type: "tool_call_delta", toolCallId: "c", argsJson: "{}" };
      } else yield { type: "text_delta", text: "done" };
    })();
    f.tools.register({ schema: f.tools.getSchemas()[0]!, execute: async () => ({ output: "payload ".repeat(20000), isError: false }) });
    const events = await f.run();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.messages.slice(0, prefix.length)).toEqual(prefix);
    expect(f.requests[1]!.messages[prefix.length]!.content.slice(0, 2)).toEqual(thinkingBlocks);
    expect(f.requests[1]!.messages[prefix.length + 1]!.content[0]!.toolResult).toHaveLength(40000);
    expect(events.at(-1)).toEqual({ type: "turn_complete" });
  });

  it.each(["system", "tools", "model", "adapter", "reload"])("invalidates completed thinking on %s change across consecutive loop invocations", async change => {
    const f = fixture();
    await f.run();
    f.conversation.addUserMessage("next");
    if (change === "tools") f.tools.getSchemas()[0]!.description = "updated schema";
    if (change === "adapter") Object.assign(f.provider, { name: "other" });
    if (change === "reload") f.conversation.setMessages(JSON.parse(JSON.stringify(f.conversation.getMessages())));
    await f.run(change === "system" || change === "reload" ? "refreshed instructions and memory" : "instructions", change === "model" ? "other-model" : "mock");
    expect(hasThinking(f.requests[1]!.messages)).toBe(false);
    expect(f.requests[1]!.messages.flatMap(m => m.content).some(b => b.text === "answer")).toBe(true);
  });

  it.each([false, true])("preserves known active thinking after reload (overflow: %s)", async overflow => {
    const f = fixture();
    let count = 0;
    f.provider.stream = params => (async function* (): AsyncGenerator<StreamEvent> {
      f.requests.push(structuredClone({ ...params, signal: undefined }));
      if (count++ === 0) {
        for (const block of signed()) yield { type: "thinking_block", block };
        yield { type: "tool_call_start", toolCallId: "c", toolName: "read_file" };
        yield { type: "tool_call_delta", toolCallId: "c", argsJson: "{}" };
      } else if (overflow) throw Error("context window exceeded");
      else yield { type: "text_delta", text: "done" };
    })();
    // Exhaust the first invocation immediately after executing its tool call.
    await drain({ provider: f.provider, conversation: f.conversation, toolRegistry: f.tools,
      model: "mock", systemPrompt: "instructions", iterationsBudget: { remaining: 1, total: 1 } });
    f.conversation.setMessages(JSON.parse(JSON.stringify(f.conversation.getMessages())));
    const before = structuredClone(f.conversation.getMessages());
    const events = await f.run();
    expect(f.requests[1]!.messages).toEqual(before);
    expect(hasThinking(f.requests[1]!.messages)).toBe(true);
    if (overflow) {
      expect(f.conversation.getMessages()).toEqual(before);
      expect(events.at(-1)).toMatchObject({ type: "error", error: { message: "context window exceeded" } });
      expect(f.requests).toHaveLength(2); // no invalid fallback/summary request
    } else expect(events.at(-1)).toEqual({ type: "turn_complete" });
  });

  it.each([
    ["thinking-only", false], ["thinking-only", true],
    ["redacted-only", false], ["redacted-only", true],
    ["text-bearing", false], ["text-bearing", true],
  ] as const)("replays a %s max-token continuation after durable reload (prefix changed: %s)", async (continuation, changed) => {
    const root = await mkdtemp(join(tmpdir(), "agav-thinking-reload-"));
    const configSpy = vi.spyOn(config, "getAgavDir").mockReturnValue(root);
    try {
      const f = fixture();
      const execute = vi.spyOn(f.tools, "execute");
      let calls = 0;
      f.provider.stream = params => (async function* (): AsyncGenerator<StreamEvent> {
        f.requests.push(structuredClone({ ...params, signal: undefined }));
        if (calls++ === 0) {
          for (const block of signed()) yield { type: "thinking_block", block };
          yield { type: "tool_call_start", toolCallId: "c", toolName: "read_file" };
          yield { type: "tool_call_delta", toolCallId: "c", argsJson: "{}" };
          yield { type: "message_end", stopReason: "tool_use" };
        } else if (calls === 2) {
          yield { type: "thinking_block", block: signed()[continuation === "redacted-only" ? 1 : 0]! };
          if (continuation === "text-bearing") yield { type: "text_delta", text: "partial answer" };
          yield { type: "message_end", stopReason: "max_tokens" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "message_end", stopReason: "end_turn" };
        }
      })();
      expect((await f.run()).at(-1)).toEqual({ type: "turn_complete" });
      expect(f.requests).toHaveLength(2);
      const before = structuredClone(f.conversation.getMessages());
      expect(before.at(-1)?.content.map(b => b.type)).toEqual(continuation === "text-bearing"
        ? ["thinking", "text"] : [continuation === "redacted-only" ? "redacted_thinking" : "thinking"]);
      const id = await saveSession(before, "mock", "mock");
      const saved = await loadSession(id);
      expect(saved?.messages).toEqual(before);
      const restored = new ConversationState(true);
      restored.setMessages(saved!.messages);
      const events = await drain({ provider: f.provider, conversation: restored, toolRegistry: f.tools,
        model: "mock", systemPrompt: changed ? "updated instructions" : "instructions",
        iterationsBudget: { remaining: 5, total: 5 } });
      expect(events.at(-1)).toEqual({ type: "turn_complete" });
      expect(f.requests).toHaveLength(3);
      expect(execute).toHaveBeenCalledTimes(1);
      const outgoing = f.requests[2]!.messages;
      if (!changed) expect(outgoing).toEqual(before);
      else {
        expect(hasThinking(outgoing)).toBe(false);
        const blocks = outgoing.flatMap(m => m.content);
        if (continuation === "text-bearing") {
          expect(blocks.some(b => b.type === "tool_use")).toBe(true);
          expect(blocks.some(b => b.type === "tool_result")).toBe(true);
          expect(blocks.some(b => b.text === "partial answer")).toBe(true);
          expect(JSON.stringify(outgoing)).not.toContain("Previous tool call");
        } else {
          expect(blocks.every(b => b.type === "text")).toBe(true);
          expect(JSON.stringify(outgoing)).toContain("Previous tool call c");
          expect(JSON.stringify(outgoing)).toContain("Previous tool result c");
          expect(JSON.stringify(outgoing)).toContain("ok");
        }
      }
      expect(restored.getTranscript().slice(0, before.length)).toEqual(before);
    } finally {
      configSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps completed thinking when a restored prefix is identical", async () => {
    const f = fixture();
    await f.run();
    f.conversation.setMessages(JSON.parse(JSON.stringify(f.conversation.getMessages())));
    f.conversation.addUserMessage("next");
    await f.run();
    expect(hasThinking(f.requests[1]!.messages)).toBe(true);
  });

  it.each(["system", "tools"])("restarts a known active round after %s changes without executing tools again", async change => {
    const f = fixture();
    const execute = vi.spyOn(f.tools, "execute");
    let count = 0;
    f.provider.stream = params => (async function* (): AsyncGenerator<StreamEvent> {
      f.requests.push(structuredClone({ ...params, signal: undefined }));
      if (count++ === 0) {
        for (const block of signed()) yield { type: "thinking_block", block };
        yield { type: "tool_call_start", toolCallId: "c", toolName: "read_file" };
        yield { type: "tool_call_delta", toolCallId: "c", argsJson: "{}" };
      } else yield { type: "text_delta", text: "done" };
    })();
    await drain({ provider: f.provider, conversation: f.conversation, toolRegistry: f.tools,
      model: "mock", systemPrompt: "instructions", iterationsBudget: { remaining: 1, total: 1 } });
    f.conversation.setMessages(JSON.parse(JSON.stringify(f.conversation.getMessages())));
    if (change === "tools") f.tools.getSchemas()[0]!.description = "new tool definition";
    await f.run(change === "system" ? "refreshed memory" : "instructions");
    expect(execute).toHaveBeenCalledTimes(1);
    const blocks = f.requests[1]!.messages.flatMap(m => m.content);
    expect(blocks.every(b => b.type === "text")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("Previous tool result c");
    expect(JSON.stringify(blocks)).toContain("ok");
  });

  it("restarts legacy active tool replay as text instead of dropping only its required thinking", async () => {
    const f = fixture();
    f.conversation.addAssistantMessage([...signed(), { type: "tool_use", toolCallId: "c", toolName: "read_file", toolInput: {} }]);
    f.conversation.addToolResults([{ type: "tool_result", toolCallId: "c", toolResult: "important result" }]);
    const transcript = f.conversation.getTranscript();
    await f.run("new prompt");
    const blocks = f.requests[0]!.messages.flatMap(m => m.content);
    expect(blocks.some(b => ["thinking", "redacted_thinking", "tool_use", "tool_result"].includes(b.type))).toBe(false);
    expect(JSON.stringify(blocks)).toContain("important result");
    expect(f.conversation.getTranscript().slice(0, transcript.length)).toEqual(transcript);
  });
});
