import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../providers/gemini.js";
import type { Message, StreamEvent } from "../providers/types.js";

/** Serialise objects as an SSE body of the shape streamGenerateContent returns. */
function sseBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
}

function mockFetch(chunks: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, body: sseBody(chunks) })),
  );
}

async function collect(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of new GeminiProvider("test-key").stream({
    model: "gemini-3.5-flash-lite",
    messages: [{ role: "user", content: [{ type: "text", text: "hey" }] }],
    systemPrompt: "sys",
  })) {
    events.push(event);
  }
  return events;
}

const usageOf = (events: StreamEvent[]) => events.filter((e) => e.type === "usage");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeminiProvider usage accounting", () => {
  // Gemini repeats usageMetadata on every chunk with cumulative totals. The
  // consumer sums usage events, so one event per chunk would report 3x here.
  it("emits a single usage event carrying the final cumulative totals", async () => {
    mockFetch([
      {
        usageMetadata: { promptTokenCount: 14000, candidatesTokenCount: 20 },
        candidates: [{ content: { parts: [{ text: "He" }] } }],
      },
      {
        usageMetadata: { promptTokenCount: 14000, candidatesTokenCount: 45 },
        candidates: [{ content: { parts: [{ text: "y" }] } }],
      },
      {
        usageMetadata: { promptTokenCount: 14000, candidatesTokenCount: 72 },
        candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }],
      },
    ]);

    const events = await collect();
    const usage = usageOf(events);

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 14000, outputTokens: 72, cacheReadTokens: 0 });

    // The rest of the stream is untouched.
    expect(
      events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join(""),
    ).toBe("Hey!");
    expect(events.some((e) => e.type === "message_end")).toBe(true);
  });

  it("reports cached tokens once rather than per chunk", async () => {
    mockFetch([
      {
        usageMetadata: {
          promptTokenCount: 14000,
          candidatesTokenCount: 10,
          cachedContentTokenCount: 13000,
        },
        candidates: [{ content: { parts: [{ text: "hi" }] } }],
      },
      {
        usageMetadata: {
          promptTokenCount: 14000,
          candidatesTokenCount: 18,
          cachedContentTokenCount: 13000,
        },
        candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }],
      },
    ]);

    const usage = usageOf(await collect());
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ cacheReadTokens: 13000, inputTokens: 14000 });
  });

  // The final chunk often carries finishReason with no parts, which the parts
  // loop skips — usage still has to survive that path.
  it("emits usage when the terminal chunk has no content parts", async () => {
    mockFetch([
      {
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 5 },
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      },
      {
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 7 },
        candidates: [{ finishReason: "STOP" }],
      },
    ]);

    const usage = usageOf(await collect());
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 900, outputTokens: 7 });
  });

  it("emits no usage event when the response carries no usageMetadata", async () => {
    mockFetch([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    expect(usageOf(await collect())).toHaveLength(0);
  });
});

/**
 * Replay a multi-turn session against one provider instance, mirroring what the
 * agent loop does: each tool call is recorded under the id the provider minted.
 */
async function runToolTurns(turns: number): Promise<{ bodies: any[]; ids: string[] }> {
  const bodies: any[] = [];
  let nextChunks: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, body: sseBody(nextChunks) };
    }),
  );

  const provider = new GeminiProvider("test-key");
  const messages: Message[] = [];
  const ids: string[] = [];

  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: "user", content: [{ type: "text", text: `question ${turn}` }] });

    nextChunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                { text: `thinking ${turn}`, thought: true, thought_signature: `sig${turn}` },
                { functionCall: { name: "read_file", args: { path: `f${turn}.ts` } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ];

    let callId = "";
    for await (const ev of provider.stream({ model: "m", messages, systemPrompt: "s" })) {
      if (ev.type === "tool_call_start") callId = ev.toolCallId;
    }
    ids.push(callId);

    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", toolCallId: callId, toolName: "read_file", toolInput: { path: `f${turn}.ts` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", toolCallId: callId, toolResult: `contents ${turn}` }],
    });
  }

  // One last request so the final captured body contains every completed turn.
  nextChunks = [{ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }];
  for await (const _ of provider.stream({ model: "m", messages, systemPrompt: "s" })) {
    /* drain */
  }

  return { bodies, ids };
}

describe("GeminiProvider history replay", () => {
  // callCounter used to live inside stream(), so every turn's first tool call
  // was gemini_call_0 and each turn clobbered the previous turn's stored parts.
  it("mints unique tool call ids across turns", async () => {
    const { ids } = await runToolTurns(3);
    expect(ids).toEqual(["gemini_call_0", "gemini_call_1", "gemini_call_2"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("replays each turn's own thought signature and arguments", async () => {
    const { bodies } = await runToolTurns(3);
    const modelTurns = bodies
      .at(-1)!
      .contents.filter((c: any) => c.role === "model");

    expect(modelTurns).toHaveLength(3);
    modelTurns.forEach((turn: any, i: number) => {
      expect(turn.parts[0]).toMatchObject({ text: `thinking ${i}`, thought_signature: `sig${i}` });
      expect(turn.parts[1].functionCall.args).toEqual({ path: `f${i}.ts` });
    });
  });

  // Prompt caching keys on an exact prefix match, so an already-sent message
  // must serialise identically forever. Anything else silently costs full price.
  it("keeps the request prefix append-only across turns", async () => {
    const { bodies } = await runToolTurns(3);
    const serialise = (body: any) => body.contents.map((c: any) => JSON.stringify(c));

    for (let i = 1; i < bodies.length; i++) {
      const previous = serialise(bodies[i - 1]);
      const current = serialise(bodies[i]);
      expect(current.length).toBeGreaterThan(previous.length);
      expect(current.slice(0, previous.length)).toEqual(previous);
    }
  });

  // A resumed session replays ids minted by an earlier process whose counter
  // also started at zero; new ids must not collide with those.
  it("mints ids above any replayed from a previous session", async () => {
    mockFetch([
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: "read_file", args: {} } }] }, finishReason: "STOP" },
        ],
      },
    ]);

    const provider = new GeminiProvider("test-key");
    const resumed: Message[] = [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", toolCallId: "gemini_call_7", toolName: "read_file", toolInput: {} }],
      },
      { role: "user", content: [{ type: "tool_result", toolCallId: "gemini_call_7", toolResult: "x" }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ];

    let callId = "";
    for await (const ev of provider.stream({ model: "m", messages: resumed, systemPrompt: "s" })) {
      if (ev.type === "tool_call_start") callId = ev.toolCallId;
    }

    expect(callId).toBe("gemini_call_8");
  });
});
