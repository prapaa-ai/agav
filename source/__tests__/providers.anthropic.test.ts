import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the argument object passed to client.messages.stream so we can assert
// on the request shape (cache breakpoints in particular). The mocked stream
// yields a single message_delta so the async generator terminates cleanly.
const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { stream: streamMock };
      constructor(_options: any) {}
    },
  };
});

const { AnthropicProvider } = await import("../providers/anthropic.js");

function mockStream() {
  streamMock.mockImplementation(() => (async function* () {
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
  })());
}

async function drain(provider: InstanceType<typeof AnthropicProvider>, params: any): Promise<void> {
  for await (const _ of provider.stream({ model: "claude-sonnet-4-5", systemPrompt: "system", ...params })) {
    /* drain */
  }
}

/** The object handed to client.messages.stream on the most recent call. */
function lastRequest(): any {
  return streamMock.mock.calls[streamMock.mock.calls.length - 1]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStream();
});

describe("AnthropicProvider cache breakpoints", () => {
  it("caches the system prompt and the last tool definition", async () => {
    await drain(new AnthropicProvider("key"), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        { name: "a", description: "A", inputSchema: { type: "object" } },
        { name: "b", description: "B", inputSchema: { type: "object" } },
      ],
    });

    const req = lastRequest();
    expect(req.system[0]).toMatchObject({ text: "system", cache_control: { type: "ephemeral" } });
    // Only the last tool carries the breakpoint (covers the whole tool list).
    expect(req.tools[0].cache_control).toBeUndefined();
    expect(req.tools[1]).toMatchObject({ name: "b", cache_control: { type: "ephemeral" } });
  });

  it("marks the conversation prefix on the second-to-last message", async () => {
    await drain(new AnthropicProvider("key"), {
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    });

    const req = lastRequest();
    expect(req.messages[1].content[0]).toMatchObject({ text: "reply", cache_control: { type: "ephemeral" } });
    expect(req.messages[0].content[0].cache_control).toBeUndefined();
    expect(req.messages[2].content[0].cache_control).toBeUndefined();
  });

  it("places the breakpoint on the last block of a multi-block tool-cycle turn", async () => {
    await drain(new AnthropicProvider("key"), {
      messages: [
        { role: "user", content: [{ type: "text", text: "read the file" }] },
        { role: "assistant", content: [
          { type: "text", text: "Reading it now" },
          { type: "tool_use", toolCallId: "call_1", toolName: "read_file", toolInput: { path: "a.ts" } },
        ] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", toolResult: "file contents" }] },
      ],
    });

    const secondToLast = lastRequest().messages[1].content;
    expect(secondToLast[0].cache_control).toBeUndefined();
    expect(secondToLast[secondToLast.length - 1]).toMatchObject({
      type: "tool_use",
      cache_control: { type: "ephemeral" },
    });
    expect(lastRequest().messages[2].content[0].cache_control).toBeUndefined();
  });

  it("adds no conversation breakpoint for a single-message request", async () => {
    await drain(new AnthropicProvider("key"), {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const req = lastRequest();
    // cacheIndex = -1 -> no message-level breakpoint; system still cached.
    expect(req.messages[0].content[0].cache_control).toBeUndefined();
    expect(req.system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  it("does not mutate the input message history", async () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "reply" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
    ];
    const snapshot = JSON.stringify(messages);

    await drain(new AnthropicProvider("key"), { messages });

    expect(JSON.stringify(messages)).toBe(snapshot);
    expect((messages[1].content[0] as Record<string, unknown>).cache_control).toBeUndefined();
  });
});
