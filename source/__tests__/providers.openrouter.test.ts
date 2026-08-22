import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const { OpenRouterProvider } = await import("../providers/openrouter.js");

const originalFetch = globalThis.fetch;

function mockChatStream(chunks: any[]) {
  createChatCompletion.mockImplementation(async () => (async function* () {
    for (const chunk of chunks) yield chunk;
  })());
}

async function collectEvents(provider: InstanceType<typeof OpenRouterProvider>, params: any = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({
    model: "openrouter/auto",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenRouterProvider client configuration", () => {
  it("configures OpenAI client with OpenRouter baseURL, name, and default headers", () => {
    const provider = new OpenRouterProvider("test-openrouter-key");
    expect(provider.name).toBe("openrouter");
    expect(capturedClientOptions).toEqual({
      apiKey: "test-openrouter-key",
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/prapaa-ai/agav",
        "X-OpenRouter-Title": "Agav",
      },
    });
  });
});

describe("OpenRouterProvider getContextWindow", () => {
  it("fetches context window from OpenRouter models endpoint and caches results", async () => {
    const fetchMock = vi.fn(async (input: any, init: any) => {
      if (String(input) === "https://openrouter.ai/api/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "anthropic/claude-sonnet-4.5", context_length: 200000 },
              { id: "google/gemini-flash-1.5", context_length: 1000000 },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    globalThis.fetch = fetchMock;

    const provider = new OpenRouterProvider("test-key");

    // First call fetches models
    const sonnetContext = await provider.getContextWindow("anthropic/claude-sonnet-4.5");
    expect(sonnetContext).toBe(200000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call for another model uses cached result
    const geminiContext = await provider.getContextWindow("google/gemini-flash-1.5");
    expect(geminiContext).toBe(1000000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for unknown models and caches the miss until the TTL expires", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "anthropic/claude-sonnet-4.5", context_length: 200000 }],
      }),
    })) as any;
    globalThis.fetch = fetchMock;

    const provider = new OpenRouterProvider("test-key");

    const missingContext = await provider.getContextWindow("unknown/model");
    expect(missingContext).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call does not re-fetch until the negative cache expires.
    const missingAgain = await provider.getContextWindow("unknown/model");
    expect(missingAgain).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await provider.getContextWindow("unknown/model");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns undefined when fetch fails or returns non-ok status", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as any;

    const provider = new OpenRouterProvider("test-key");
    const result = await provider.getContextWindow("anthropic/claude-sonnet-4.5");
    expect(result).toBeUndefined();
  });

  it("returns undefined when fetch throws network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Network error");
    }) as any;

    const provider = new OpenRouterProvider("test-key");
    const result = await provider.getContextWindow("anthropic/claude-sonnet-4.5");
    expect(result).toBeUndefined();
  });
});

describe("OpenRouterProvider streaming chat completions", () => {
  it("uses max_tokens instead of max_completion_tokens in chat request", async () => {
    mockChatStream([
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);

    const provider = new OpenRouterProvider("test-key");
    await collectEvents(provider, { model: "openrouter/auto", maxTokens: 8192 });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    const callArgs = createChatCompletion.mock.calls[0]?.[0];
    expect(callArgs.max_tokens).toBe(8192);
    expect(callArgs.max_completion_tokens).toBeUndefined();
  });

  it("defaults max_tokens to 16384 when not specified", async () => {
    mockChatStream([
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);

    const provider = new OpenRouterProvider("test-key");
    await collectEvents(provider, { model: "openrouter/auto" });

    const callArgs = createChatCompletion.mock.calls[0]?.[0];
    expect(callArgs.max_tokens).toBe(16384);
    expect(callArgs.max_completion_tokens).toBeUndefined();
  });

  it("uses prompt steering instead of reasoning_effort for mixed model families", async () => {
    mockChatStream([
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);

    const provider = new OpenRouterProvider("test-key");
    await collectEvents(provider, { model: "deepseek/deepseek-chat-v3.1", effort: "high" });

    const callArgs = createChatCompletion.mock.calls[0]?.[0];
    expect(callArgs.reasoning_effort).toBeUndefined();
    expect(callArgs.messages[0]?.content).toContain("Think carefully");
  });

  it("emits thinking_delta events when delta.reasoning is provided", async () => {
    mockChatStream([
      { choices: [{ delta: { reasoning: "Analyzing the prompt..." } }] },
      { choices: [{ delta: { reasoning: " Formulating plan." } }] },
      { choices: [{ delta: { content: "Here is the answer." }, finish_reason: "stop" }] },
    ]);

    const provider = new OpenRouterProvider("test-key");
    const events = await collectEvents(provider);

    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas).toEqual([
      { type: "thinking_delta", text: "Analyzing the prompt..." },
      { type: "thinking_delta", text: " Formulating plan." },
    ]);

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toEqual([
      { type: "text_delta", text: "Here is the answer." },
    ]);
  });

  it("emits tool call events and usage metadata correctly", async () => {
    mockChatStream([
      {
        usage: { prompt_tokens: 50, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 10 } },
        choices: [],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_abc", function: { name: "read_file", arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"test.txt"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    const provider = new OpenRouterProvider("test-key");
    const events = await collectEvents(provider);

    expect(events).toEqual([
      { type: "message_start" },
      { type: "usage", inputTokens: 50, outputTokens: 25, cacheReadTokens: 10 },
      { type: "tool_call_start", toolCallId: "call_abc", toolName: "read_file" },
      { type: "tool_call_delta", toolCallId: "call_abc", argsJson: '{"path":' },
      { type: "tool_call_delta", toolCallId: "call_abc", argsJson: '"test.txt"}' },
      { type: "tool_call_end", toolCallId: "call_abc" },
      { type: "message_end", stopReason: "tool_calls" },
    ]);
  });
});
