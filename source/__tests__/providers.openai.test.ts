import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../providers/types.js";

const createChatCompletion = vi.fn();
const createResponse = vi.fn();
let capturedClientOptions: any = null;

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      constructor(options: any) {
        capturedClientOptions = options;
      }
      chat = {
        completions: {
          create: createChatCompletion,
        },
      };
      responses = {
        create: createResponse,
      };
    },
  };
});

const { OpenAIProvider } = await import("../providers/openai.js");

function mockChatStream(chunks: any[]) {
  createChatCompletion.mockImplementation(async () => (async function* () {
    for (const chunk of chunks) yield chunk;
  })());
}

function mockResponsesStream(events: any[]) {
  createResponse.mockImplementation(async () => (async function* () {
    for (const event of events) yield event;
  })());
}

async function collectEvents(provider: InstanceType<typeof OpenAIProvider>, params: any = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({
    model: "gpt-4o",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    systemPrompt: "sys",
    ...params,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedClientOptions = null;
});

describe("OpenAIProvider configuration options", () => {
  it("defaults to openai name and standard options", () => {
    const provider = new OpenAIProvider("test-key");
    expect(provider.name).toBe("openai");
    expect(capturedClientOptions).toEqual({
      apiKey: "test-key",
      baseURL: undefined,
      defaultHeaders: undefined,
    });
  });

  it("supports custom name, baseURL, and defaultHeaders", () => {
    const provider = new OpenAIProvider("test-key", "chat", {
      name: "custom-openai",
      baseURL: "https://custom.openai.endpoint/v1",
      defaultHeaders: { "X-Custom-Header": "custom-value" },
    });
    expect(provider.name).toBe("custom-openai");
    expect(capturedClientOptions).toEqual({
      apiKey: "test-key",
      baseURL: "https://custom.openai.endpoint/v1",
      defaultHeaders: { "X-Custom-Header": "custom-value" },
    });
  });
});

describe("OpenAIProvider chat streaming", () => {
  it("uses max_completion_tokens for standard OpenAI provider", async () => {
    mockChatStream([
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    ]);

    const provider = new OpenAIProvider("test-key", "chat");
    await collectEvents(provider, { model: "gpt-4o", maxTokens: 4096 });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    const callArgs = createChatCompletion.mock.calls[0]?.[0];
    expect(callArgs.max_completion_tokens).toBe(4096);
    expect(callArgs.max_tokens).toBeUndefined();
  });

  it("emits thinking_delta when reasoning is in delta", async () => {
    mockChatStream([
      { choices: [{ delta: { reasoning: "Thinking deeply..." } }] },
      { choices: [{ delta: { content: "Final answer" }, finish_reason: "stop" }] },
    ]);

    const provider = new OpenAIProvider("test-key", "chat");
    const events = await collectEvents(provider);

    expect(events).toContainEqual({ type: "thinking_delta", text: "Thinking deeply..." });
    expect(events).toContainEqual({ type: "text_delta", text: "Final answer" });
  });

  it("does not emit thinking_delta when reasoning is empty or not a string", async () => {
    mockChatStream([
      { choices: [{ delta: { reasoning: "" } }] },
      { choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] },
    ]);

    const provider = new OpenAIProvider("test-key", "chat");
    const events = await collectEvents(provider);

    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  });
});

describe("OpenAIProvider responses streaming", () => {
  it("emits thinking_delta on reasoning summary delta", async () => {
    mockResponsesStream([
      { type: "response.reasoning_summary_text.delta", delta: "Step 1 thinking" },
      { type: "response.output_text.delta", delta: "Result" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);

    const provider = new OpenAIProvider("test-key", "responses");
    const events = await collectEvents(provider);

    expect(events).toContainEqual({ type: "thinking_delta", text: "Step 1 thinking" });
    expect(events).toContainEqual({ type: "text_delta", text: "Result" });
    expect(events).toContainEqual({ type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });
    expect(events).toContainEqual({ type: "message_end", stopReason: "completed" });
  });
});
