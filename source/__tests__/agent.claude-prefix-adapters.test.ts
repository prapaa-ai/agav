import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeThinkingEvents } from "./helpers/claude-thinking.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { RetryProvider } from "../providers/retry.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LLMProvider } from "../providers/types.js";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {
  messages = { stream: streamMock };
} }));
import { AnthropicProvider } from "../providers/anthropic.js";
import { VertexAIAuth, VertexAIProvider } from "../providers/vertex-ai.js";

afterEach(() => vi.restoreAllMocks());

it.each(["anthropic", "vertex"])("handles refreshed instructions through consecutive actual %s adapter loop invocations", async adapter => {
  const requests: any[] = [];
  const events = [...claudeThinkingEvents,
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "answer" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "answer" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ];
  let provider: LLMProvider;
  if (adapter === "anthropic") {
    streamMock.mockImplementation((request: unknown) => {
      requests.push(request);
      return (async function* () { yield* events; })();
    });
    provider = new AnthropicProvider("not-a-real-key");
  } else {
    vi.spyOn(VertexAIAuth.prototype, "getProjectId").mockResolvedValue("project");
    vi.spyOn(VertexAIAuth.prototype, "getAccessToken").mockResolvedValue("token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
    provider = new VertexAIProvider("unused");
  }
  provider = new RetryProvider(provider, 0);
  const conversation = new ConversationState();
  conversation.addUserMessage("first");
  const tools = new ToolRegistry();
  const run = async (systemPrompt: string) => {
    for await (const event of runAgentLoop({ provider, conversation, toolRegistry: tools,
      model: adapter === "anthropic" ? "claude-opus-5-5" : "vertex/claude-opus-5-5", systemPrompt,
      iterationsBudget: { remaining: 3, total: 3 },
    })) expect(event.type).not.toBe("error");
  };
  await run("AGAV.md instructions and memory v1");
  expect(conversation.getMessages()[1]?.thinkingPrefix).toMatch(/^[a-f0-9]{64}$/);
  // Worker/checkpoint/history persistence stores messages; no live adapter state.
  conversation.setMessages(JSON.parse(JSON.stringify(conversation.getMessages())));
  conversation.addUserMessage("second");
  await run("AGAV.md instructions and memory v2");
  expect(requests).toHaveLength(2);
  expect(requests[1].system[0].text).toContain("memory v2");
  expect(requests[1].messages.flatMap((m: any) => m.content).some((b: any) => ["thinking", "redacted_thinking"].includes(b.type))).toBe(false);
  expect(JSON.stringify(requests[1].messages)).toContain("answer");
});

describe("effective Claude prefix", () => {
  it("tracks only wire tools and effective effort prompt, not permission flags", () => {
    const provider = new AnthropicProvider("key");
    const params = { model: "claude-opus-5-5", messages: [], systemPrompt: "system",
      tools: [{ name: "read", description: "read", inputSchema: { type: "object" }, destructive: false }] };
    const original = provider.getThinkingPrefix(params);
    params.tools[0]!.destructive = true;
    expect(provider.getThinkingPrefix(params)).toBe(original);
    expect(provider.getThinkingPrefix({ ...params, effort: "high" })).not.toBe(original);
    const native = { ...params, model: "claude-sonnet-4-5" };
    expect(provider.getThinkingPrefix({ ...native, effort: "high" })).toBe(provider.getThinkingPrefix({ ...native, effort: "low" }));
    params.tools[0]!.inputSchema = { type: "string" };
    expect(provider.getThinkingPrefix(params)).not.toBe(original);
  });

  it("distinguishes adapter and Vertex location but survives adapter reconstruction", () => {
    const params = { model: "claude-opus-5-5", messages: [] };
    const prefix = new VertexAIProvider("unused", "us").getThinkingPrefix(params);
    expect(new VertexAIProvider("unused", "us").getThinkingPrefix(params)).toBe(prefix);
    expect(new VertexAIProvider("unused", "eu").getThinkingPrefix(params)).not.toBe(prefix);
    expect(new AnthropicProvider("key").getThinkingPrefix(params)).not.toBe(prefix);
  });
});
