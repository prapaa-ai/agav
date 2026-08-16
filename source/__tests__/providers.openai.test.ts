import { describe, expect, it, vi, beforeEach } from "vitest";

import type { StreamEvent } from "../providers/types.js";

const captured = {
  responses: null as any,
  chat: null as any,
  clientOpts: null as any,
};

/** Events the mocked SDK replays for the next call, set per test. */
let chatChunks: unknown[] = [];
let responseEvents: unknown[] = [];

function replay(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: vi.fn(async (params: any) => {
        captured.responses = params;
        return replay(responseEvents);
      }),
    };

    chat = {
      completions: {
        create: vi.fn(async (params: any) => {
          captured.chat = params;
          return replay(chatChunks);
        }),
      },
    };

    constructor(opts: any) {
      captured.clientOpts = opts;
    }
  }

  return { default: MockOpenAI };
});

const { OpenAIProvider } = await import("../providers/openai.js");

const userTurn = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

async function collect(provider: any, params: Record<string, unknown> = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({ model: "gpt-4o-mini", messages: userTurn, ...params })) {
    events.push(event);
  }
  return events;
}

const usageOf = (events: StreamEvent[]) => events.filter((e) => e.type === "usage");
const typesOf = (events: StreamEvent[]) => events.map((e) => e.type);

beforeEach(() => {
  captured.responses = null;
  captured.chat = null;
  captured.clientOpts = null;
  chatChunks = [];
  responseEvents = [];
});

describe("OpenAIProvider wiring", () => {
  it("talks to the default OpenAI host and identifies itself as openai", async () => {
    const provider = new OpenAIProvider("test-key");

    expect(provider.name).toBe("openai");
    expect(captured.clientOpts).toEqual({ apiKey: "test-key" });
    // No baseURL key at all — passing undefined would override the SDK default.
    expect(captured.clientOpts).not.toHaveProperty("baseURL");
  });

  it("asks for usage on the chat stream", async () => {
    await collect(new OpenAIProvider("test-key", "chat"));

    expect(captured.chat).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
});

describe("OpenAIProvider token limits", () => {
  // GroqProvider narrows this per model. OpenAI must stay uncapped: clamping
  // here would silently truncate long outputs on models that allow them.
  it("sends the requested budget unchanged in both modes", async () => {
    await collect(new OpenAIProvider("test-key", "responses"), { maxTokens: 100_000 });
    expect(captured.responses.max_output_tokens).toBe(100_000);

    await collect(new OpenAIProvider("test-key", "chat"), { maxTokens: 100_000 });
    expect(captured.chat.max_completion_tokens).toBe(100_000);
  });

  it("defaults to 16384 when the caller names no budget", async () => {
    await collect(new OpenAIProvider("test-key", "chat"));

    expect(captured.chat.max_completion_tokens).toBe(16384);
  });
});

describe("OpenAIProvider usage accounting", () => {
  // Consumers add each usage event to a running total, so more than one per
  // request inflates what the user is told they spent.
  //
  // Chunk shapes below mirror live gpt-4o-mini traffic captured 2026-08-16:
  // the finish_reason chunk carries no usage, and usage arrives afterwards on
  // a trailing chunk with an empty choices array.
  it("emits one usage event, after message_end, in chat mode", async () => {
    chatChunks = [
      { choices: [{ delta: { role: "assistant", content: "" } }] },
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " there" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 19, completion_tokens: 5, total_tokens: 24 } },
    ];

    const events = await collect(new OpenAIProvider("test-key", "chat"));

    expect(usageOf(events)).toEqual([
      { type: "usage", inputTokens: 19, outputTokens: 5, cacheReadTokens: 0 },
    ]);
    expect(typesOf(events)).toEqual([
      "message_start", "text_delta", "text_delta", "message_end", "usage",
    ]);
  });

  it("emits one usage event, after message_end, in responses mode", async () => {
    responseEvents = [
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " there" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 19, output_tokens: 6, input_tokens_details: { cached_tokens: 0 } },
        },
      },
    ];

    const events = await collect(new OpenAIProvider("test-key", "responses"));

    expect(usageOf(events)).toEqual([
      { type: "usage", inputTokens: 19, outputTokens: 6, cacheReadTokens: 0 },
    ]);
    expect(typesOf(events)).toEqual([
      "message_start", "text_delta", "text_delta", "message_end", "usage",
    ]);
  });

  // A misbehaving OpenAI-compatible endpoint repeating cumulative usage on
  // every chunk is what this provider guards against — Groq does exactly this,
  // and it inherits both streaming paths from here.
  it("collapses repeated cumulative usage to a single event", async () => {
    chatChunks = [
      { usage: { prompt_tokens: 900, completion_tokens: 10 }, choices: [{ delta: { content: "a" } }] },
      { usage: { prompt_tokens: 900, completion_tokens: 25 }, choices: [{ delta: { content: "b" } }] },
      { usage: { prompt_tokens: 900, completion_tokens: 41 }, choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const usage = usageOf(await collect(new OpenAIProvider("test-key", "chat")));

    expect(usage).toHaveLength(1);
    // The last report wins: these are cumulative, not deltas.
    expect(usage[0]).toMatchObject({ inputTokens: 900, outputTokens: 41 });
  });

  it("reports cached prompt tokens from each API's own field name", async () => {
    chatChunks = [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      {
        choices: [],
        usage: { prompt_tokens: 2432, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 2176 } },
      },
    ];
    expect(usageOf(await collect(new OpenAIProvider("test-key", "chat")))[0])
      .toMatchObject({ inputTokens: 2432, cacheReadTokens: 2176 });

    responseEvents = [
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 2432, output_tokens: 9, input_tokens_details: { cached_tokens: 2176 } },
        },
      },
    ];
    expect(usageOf(await collect(new OpenAIProvider("test-key", "responses")))[0])
      .toMatchObject({ inputTokens: 2432, cacheReadTokens: 2176 });
  });

  it("emits no usage event when the endpoint reports none", async () => {
    chatChunks = [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }];
    expect(usageOf(await collect(new OpenAIProvider("test-key", "chat")))).toHaveLength(0);

    responseEvents = [{ type: "response.completed", response: { status: "completed" } }];
    expect(usageOf(await collect(new OpenAIProvider("test-key", "responses")))).toHaveLength(0);
  });

  // Holding usage back until the stream ends must not swallow it when the turn
  // ends in tool calls rather than text — that is the common case in an agent
  // loop, and dropping it would under-report every tool-using turn.
  it("still emits usage on a turn that ends in a tool call", async () => {
    chatChunks = [
      {
        choices: [{
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] },
        }],
      },
      {
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] },
        }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 54, completion_tokens: 14 } },
    ];

    const events = await collect(new OpenAIProvider("test-key", "chat"), {
      tools: [{ name: "read_file", description: "read", inputSchema: { type: "object", properties: {} } }],
    });

    expect(typesOf(events)).toEqual([
      "message_start", "tool_call_start", "tool_call_delta", "tool_call_end", "message_end", "usage",
    ]);
    expect(usageOf(events)[0]).toMatchObject({ inputTokens: 54, outputTokens: 14 });
  });
});
