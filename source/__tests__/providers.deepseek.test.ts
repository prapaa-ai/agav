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

const { DeepSeekProvider } = await import("../providers/deepseek.js");

const originalFetch = globalThis.fetch;

function mockChatStream(chunks: any[]) {
  createChatCompletion.mockImplementation(async () => (async function* () {
    for (const chunk of chunks) yield chunk;
  })());
}

async function collectEvents(provider: InstanceType<typeof DeepSeekProvider>, params: any = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({
    model: "deepseek-v4-pro",
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

describe("DeepSeekProvider client configuration", () => {
  it("configures OpenAI client with DeepSeek baseURL and name", () => {
    const provider = new DeepSeekProvider("test-deepseek-key");
    expect(provider.name).toBe("deepseek");
    expect(capturedClientOptions).toEqual({
      apiKey: "test-deepseek-key",
      baseURL: "https://api.deepseek.com",
      defaultHeaders: undefined,
    });
  });
});

describe("DeepSeekProvider getContextWindow", () => {
  it("fetches context window from DeepSeek models endpoint and caches results", async () => {
    const fetchMock = vi.fn(async (input: any, init: any) => {
      if (String(input) === "https://api.deepseek.com/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "deepseek-v4-pro", context_length: 131072 },
              { id: "deepseek-v4-flash", context_length: 65536 },
            ],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    globalThis.fetch = fetchMock;

    const provider = new DeepSeekProvider("test-key");

    const proContext = await provider.getContextWindow("deepseek-v4-pro");
    expect(proContext).toBe(131072);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call uses cached result
    const flashContext = await provider.getContextWindow("deepseek-v4-flash");
    expect(flashContext).toBe(65536);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for unknown models and caches the miss", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "deepseek-v4-pro", context_length: 131072 }],
      }),
    })) as any;
    globalThis.fetch = fetchMock;

    const provider = new DeepSeekProvider("test-key");

    const missingContext = await provider.getContextWindow("unknown-model");
    expect(missingContext).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call does not re-fetch
    const missingAgain = await provider.getContextWindow("unknown-model");
    expect(missingAgain).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as any;

    const provider = new DeepSeekProvider("test-key");
    const result = await provider.getContextWindow("deepseek-v4-pro");
    expect(result).toBeUndefined();
  });

  it("returns undefined when fetch throws network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Network error");
    }) as any;

    const provider = new DeepSeekProvider("test-key");
    const result = await provider.getContextWindow("deepseek-v4-pro");
    expect(result).toBeUndefined();
  });
});

describe("DeepSeekProvider streaming chat completions", () => {
  it("uses max_tokens instead of max_completion_tokens in chat request", async () => {
    mockChatStream([
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);

    const provider = new DeepSeekProvider("test-key");
    await collectEvents(provider, { maxTokens: 8192 });

    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    const callArgs = createChatCompletion.mock.calls[0]?.[0];
    expect(callArgs.max_tokens).toBe(8192);
    expect(callArgs.max_completion_tokens).toBeUndefined();
  });

  it("defaults max_tokens to 16384 when not specified", async () => {
    mockChatStream([
      { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);

    const provider = new DeepSeekProvider("test-key");
    await collectEvents(provider);

    const callArgs = createChatCompletion.mock.calls[0]?.[0];
    expect(callArgs.max_tokens).toBe(16384);
    expect(callArgs.max_completion_tokens).toBeUndefined();
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

    const provider = new DeepSeekProvider("test-key");
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
