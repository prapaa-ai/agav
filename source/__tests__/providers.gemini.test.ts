import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "../providers/gemini.js";
import type { ContentBlock, Message, StreamEvent } from "../providers/types.js";
import { runAgentLoop } from "../agent/loop.js";
import { ConversationState } from "../agent/conversation.js";
import { ToolRegistry } from "../tools/registry.js";

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

  it("includes thinking tokens once from the final cumulative usage-only chunk", async () => {
    mockFetch([
      {
        usageMetadata: {
          promptTokenCount: 900, candidatesTokenCount: 0, thoughtsTokenCount: 10,
          cachedContentTokenCount: 800, totalTokenCount: 910,
        },
        candidates: [{ content: { parts: [{ text: "thinking", thought: true }] } }],
      },
      {
        usageMetadata: {
          promptTokenCount: 900, candidatesTokenCount: 5, thoughtsTokenCount: 20,
          cachedContentTokenCount: 800, totalTokenCount: 925,
        },
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      },
      {
        usageMetadata: {
          promptTokenCount: 900, candidatesTokenCount: 7, thoughtsTokenCount: 30,
          cachedContentTokenCount: 800, totalTokenCount: 937,
        },
      },
    ]);

    const events = await collect();
    expect(usageOf(events)).toEqual([
      { type: "usage", inputTokens: 900, outputTokens: 37, cacheReadTokens: 800 },
    ]);
    expect(events.filter((e) => e.type === "thinking_delta")).toEqual([
      { type: "thinking_delta", text: "thinking" },
    ]);
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "ok" },
    ]);
    expect(events.at(-1)?.type).toBe("usage");
  });

  it.each([
    { usageMetadata: { candidatesTokenCount: 7, thoughtsTokenCount: 30 }, outputTokens: 37 },
    { usageMetadata: { thoughtsTokenCount: 30 }, outputTokens: 30 },
    { usageMetadata: { candidatesTokenCount: 7 }, outputTokens: 7 },
    { usageMetadata: { candidatesTokenCount: 7, thoughtsTokenCount: 0 }, outputTokens: 7 },
    { usageMetadata: {}, outputTokens: 0 },
    { usageMetadata: { totalTokenCount: 937 }, outputTokens: 0 },
  ])("defaults missing usage fields to zero: $usageMetadata", async ({ usageMetadata, outputTokens }) => {
    mockFetch([{ usageMetadata }]);
    expect(usageOf(await collect())).toEqual([
      { type: "usage", inputTokens: 0, outputTokens, cacheReadTokens: 0 },
    ]);
  });

  it("uses the latest usage snapshot without retaining earlier thinking counts", async () => {
    mockFetch([
      { usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 5, thoughtsTokenCount: 30 } },
      { usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 7, thoughtsTokenCount: 0 } },
    ]);
    expect(usageOf(await collect())).toEqual([
      { type: "usage", inputTokens: 900, outputTokens: 7, cacheReadTokens: 0 },
    ]);
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
async function runToolTurns(turns: number): Promise<{
  bodies: any[]; ids: string[]; provider: GeminiProvider; messages: Message[];
}> {
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
    let providerMetadata: Record<string, unknown> | undefined;
    for await (const ev of provider.stream({ model: "m", messages, systemPrompt: "s" })) {
      if (ev.type === "tool_call_start") callId = ev.toolCallId;
      if (ev.type === "tool_call_delta" && ev.providerMetadata) {
        providerMetadata = { ...providerMetadata, ...ev.providerMetadata };
      }
    }
    ids.push(callId);

    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", toolCallId: callId, toolName: "read_file", toolInput: { path: `f${turn}.ts` },
        ...(providerMetadata ? { providerMetadata } : {}),
      }],
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

  return { bodies, ids, provider, messages };
}

describe("GeminiProvider replay isolation", () => {
  it("persists complete multi-chunk opaque parts through the agent loop", async () => {
    const rawParts = [
      { text: "thinking", thought: true, thoughtSignature: "camel-signature", opaque: { nested: [1, 2] } },
      { text: "Checking" },
      { functionCall: { name: "read_file", args: { path: "a.ts" } }, thought_signature: "call-signature" },
      { functionCall: { name: "read_file", args: { path: "b.ts" } } },
      { thoughtSignature: "trailing-signature", opaque: ["unknown-part"] },
    ];
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const chunks = bodies.length === 1
        ? [
          { candidates: [{ content: { parts: rawParts.slice(0, 3) } }] },
          { candidates: [{ content: { parts: rawParts.slice(3) }, finishReason: "STOP" }] },
        ]
        : [{ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }];
      return { ok: true, body: sseBody(chunks) };
    }));
    const conversation = new ConversationState();
    conversation.addUserMessage("read files");
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      schema: { name: "read_file", description: "Read", inputSchema: { type: "object" } },
      execute: async () => ({ output: "contents", isError: false }),
    });
    const events = [];
    for await (const event of runAgentLoop({
      provider: new GeminiProvider("test-key"), conversation, toolRegistry, model: "m",
      iterationsBudget: { remaining: 5, total: 5 },
    })) events.push(event);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].contents[1].parts).toEqual(rawParts);
    const toolBlocks = conversation.getMessages()[1]!.content.filter((block) => block.type === "tool_use");
    expect(toolBlocks[0]!.providerMetadata).toEqual({ geminiRawTurnParts: rawParts });
    expect(toolBlocks[1]!.providerMetadata).toBeUndefined();
    expect(toolBlocks.map((block) => block.toolInput)).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
  });

  it("isolates overlapping streams without serializing requests or mutating replay history", async () => {
    const provider = new GeminiProvider("test-key");
    const histories: Message[][] = ["parent", "child"].map((text) => [
      { role: "user", content: [{ type: "text", text }] },
    ]);
    const pending: Array<() => void> = [];
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const label = body.contents[0].parts[0].text;
      return new Promise((resolve) => pending.push(() => resolve({ ok: true, body: sseBody([
        { candidates: [{ content: { parts: [
          { thoughtSignature: `${label}-signature`, opaque: { label } },
          { functionCall: { name: "read_file", args: { path: label } } },
        ] }, finishReason: "STOP" }] },
      ]) })));
    }));
    const collectTurn = async (messages: Message[]) => {
      let block: ContentBlock | undefined;
      for await (const event of provider.stream({ model: "m", messages })) {
        if (event.type === "tool_call_start") {
          block = { type: "tool_use", toolCallId: event.toolCallId, toolName: event.toolName };
        }
        if (event.type === "tool_call_delta") {
          if (event.argsJson) block!.toolInput = JSON.parse(event.argsJson);
          if (event.providerMetadata) block!.providerMetadata = event.providerMetadata;
        }
      }
      return block!;
    };
    const turns = histories.map(collectTurn);
    // Both fetches must start before either is released.
    expect(pending).toHaveLength(2);
    pending[1]!();
    pending[0]!();
    const blocks = await Promise.all(turns);
    expect(new Set(blocks.map((block) => block.toolCallId)).size).toBe(2);
    histories.forEach((messages, index) => {
      messages.push({ role: "assistant", content: [blocks[index]!] });
      messages.push({ role: "assistant", content: [{ type: "text", text: "adjacent" }] });
      messages.push({ role: "user", content: [{ type: "tool_result", toolCallId: blocks[index]!.toolCallId, toolResult: "ok" }] });
    });
    const snapshot = JSON.stringify(histories);
    const replayBodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      replayBodies.push(JSON.parse(init.body));
      return { ok: true, body: sseBody([]) };
    }));
    for (const messages of histories) {
      for await (const _ of provider.stream({ model: "m", messages })) { /* drain */ }
    }
    replayBodies.forEach((body, index) => {
      expect(body.contents[1].parts).toEqual([
        ...(blocks[index]!.providerMetadata!.geminiRawTurnParts as unknown[]),
        { text: "adjacent" },
      ]);
    });
    expect(JSON.stringify(histories)).toBe(snapshot);
  });

  it.each(["child", "summary"])("preserves parent replay after an unrelated %s request", async (kind) => {
    // More than 100 live tool turns triggers the old provider-wide pruning.
    const { bodies, provider, messages } = await runToolTurns(101);
    const parentContents = bodies.at(-1)!.contents;
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, body: sseBody([{ candidates: [{ content: { parts: [{ text: "done" }] } }] }]) };
    }));

    const unrelated: Message[] = kind === "summary"
      ? messages.slice(0, 30)
      : [{ role: "user", content: [{ type: "text", text: "child task" }] }];
    for await (const _ of provider.stream({ model: "m", messages: unrelated })) { /* drain */ }
    for await (const _ of provider.stream({ model: "m", messages })) { /* drain */ }

    expect(requests.at(-1)!.contents).toEqual(parentContents);
  });

  it("preserves replay through JSON persistence and a fresh provider", async () => {
    const { bodies, messages } = await runToolTurns(3);
    const expected = bodies.at(-1)!.contents;
    const resumed: Message[] = JSON.parse(JSON.stringify(messages));
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, body: sseBody([{ candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: {} } },
      ] } }] }]) };
    }));
    const ids: string[] = [];
    for await (const event of new GeminiProvider("test-key").stream({ model: "m", messages: resumed })) {
      if (event.type === "tool_call_start") ids.push(event.toolCallId);
    }
    expect(body.contents).toEqual(expected);
    expect(ids).toEqual(["gemini_call_3"]);
  });
});

describe("GeminiProvider synthetic calls", () => {
  it("continues explicit skill dispatch with a compatibility signature", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const call = body.contents.flatMap((turn: any) => turn.parts).find((part: any) => part.functionCall);
      if (call && call.thoughtSignature !== "skip_thought_signature_validator") {
        return { ok: false, status: 400, text: async () => "Function call is missing a thought_signature" };
      }
      return { ok: true, body: sseBody([{ candidates: [{ content: { parts: [{ text: "parent done" }] }, finishReason: "STOP" }] }]) };
    }));
    const conversation = new ConversationState();
    conversation.addUserMessage("/demo exact args");
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      schema: { name: "activate_skill", description: "Skill", inputSchema: { type: "object" } },
      execute: async () => ({ output: "skill done", isError: false }),
    });
    const events = [];
    for await (const event of runAgentLoop({
      provider: new GeminiProvider("test-key"), conversation, toolRegistry, model: "gemini-3.5-flash",
      initialToolCall: { name: "activate_skill", input: { name: "Demo", arguments: "exact args" } },
      iterationsBudget: { remaining: 5, total: 5 },
    })) events.push(event);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "assistant_message_complete", text: "parent done" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].contents[1].parts[0]).toEqual({
      functionCall: { name: "activate_skill", args: { name: "Demo", arguments: "exact args" } },
      thoughtSignature: "skip_thought_signature_validator",
    });
    expect(bodies[0].contents[2].parts[0].functionResponse).toEqual({ name: "activate_skill", response: { result: "skill done" } });
    // Serialization must not annotate the stored synthetic turn.
    expect(conversation.getMessages()[1]!.content[0]!.providerMetadata).toBeUndefined();
  });
});

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
