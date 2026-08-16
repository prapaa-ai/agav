import { describe, expect, it, vi, beforeEach } from "vitest";

import type { StreamEvent } from "../providers/types.js";

const captured = {
  responses: null as any,
  chat: null as any,
  clientOpts: null as any,
};

/** Chunks the mocked SDK replays for the next call, set per test. */
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

const { GroqProvider } = await import("../providers/groq.js");

const userTurn = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

async function collect(provider: any, model: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({ model, messages: userTurn })) {
    events.push(event);
  }
  return events;
}

const usageOf = (events: StreamEvent[]) => events.filter((e) => e.type === "usage");

beforeEach(() => {
  captured.responses = null;
  captured.chat = null;
  captured.clientOpts = null;
  chatChunks = [];
  responseEvents = [];
});

describe("GroqProvider wiring", () => {
  it("points the OpenAI client at Groq and identifies itself as groq", async () => {
    const provider = new GroqProvider("test-key", "chat");

    expect(provider.name).toBe("groq");
    expect(captured.clientOpts).toMatchObject({
      apiKey: "test-key",
      baseURL: "https://api.groq.com/openai/v1",
    });
  });
});

describe("GroqProvider token caps", () => {
  it("caps max_output_tokens for responses mode", async () => {
    const provider = new GroqProvider("test-key", "responses");
    await collect(provider, "groq/compound-mini");

    expect(captured.responses).toMatchObject({
      model: "groq/compound-mini",
      max_output_tokens: 8192,
    });
  });

  it("caps max_completion_tokens for chat mode", async () => {
    const provider = new GroqProvider("test-key", "chat");
    await collect(provider, "groq/compound-mini");

    expect(captured.chat).toMatchObject({
      model: "groq/compound-mini",
      max_completion_tokens: 8192,
    });
  });

  // A blanket 8192 floor used to apply to every Groq model, quartering the
  // output limit of the model /deep selects by default.
  it("leaves the request alone when the model allows more than we ask for", async () => {
    const provider = new GroqProvider("test-key", "chat");
    await collect(provider, "llama-3.3-70b-versatile");

    expect(captured.chat.max_completion_tokens).toBe(16384);
  });

  it("clamps to the model's real ceiling, not a shared constant", async () => {
    const caps: Record<string, number> = {};
    for (const model of ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "allam-2-7b"]) {
      for await (const _ of new GroqProvider("test-key", "chat").stream({
        model, messages: userTurn, maxTokens: 200_000,
      })) { /* drain */ }
      caps[model] = captured.chat.max_completion_tokens;
    }

    // Verified against GET /openai/v1/models on 2026-08-16.
    expect(caps).toEqual({
      "llama-3.3-70b-versatile": 32768,
      "llama-3.1-8b-instant": 131072,
      "allam-2-7b": 4096,
    });
  });

  // allam-2-7b caps at 4096, so an unlisted model cannot assume 8192 is safe.
  it("falls back below the smallest known chat ceiling for unlisted models", async () => {
    const provider = new GroqProvider("test-key", "chat");
    await collect(provider, "some-future-groq-model");

    expect(captured.chat.max_completion_tokens).toBe(4096);
  });
});

describe("GroqProvider usage accounting", () => {
  // Consumers sum usage events. An OpenAI-compatible endpoint that repeats
  // cumulative usage on every chunk would otherwise report a multiple of the
  // real cost — the exact bug Gemini shipped with.
  it("emits one usage event when every chat chunk repeats cumulative usage", async () => {
    chatChunks = [
      { usage: { prompt_tokens: 900, completion_tokens: 10 }, choices: [{ delta: { content: "he" } }] },
      { usage: { prompt_tokens: 900, completion_tokens: 25 }, choices: [{ delta: { content: "llo" } }] },
      { usage: { prompt_tokens: 900, completion_tokens: 41 }, choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    const events = await collect(new GroqProvider("test-key", "chat"), "llama-3.3-70b-versatile");
    const usage = usageOf(events);

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 900, outputTokens: 41 });

    // The rest of the stream still comes through intact.
    expect(
      events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join(""),
    ).toBe("hello");
    expect(events.some((e) => e.type === "message_end")).toBe(true);
  });

  it("emits one usage event when responses mode reports completion twice", async () => {
    const completed = {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 700, output_tokens: 30 } },
    };
    responseEvents = [
      { type: "response.output_text.delta", delta: "ok" },
      completed,
      completed,
    ];

    const usage = usageOf(await collect(new GroqProvider("test-key", "responses"), "llama-3.3-70b-versatile"));

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 700, outputTokens: 30 });
  });

  it("emits no usage event when the endpoint reports none", async () => {
    chatChunks = [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }];

    expect(usageOf(await collect(new GroqProvider("test-key", "chat"), "llama-3.3-70b-versatile"))).toHaveLength(0);
  });
});
