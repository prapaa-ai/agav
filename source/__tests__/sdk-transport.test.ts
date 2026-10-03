import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { LLMProvider, StreamEvent, StreamParams } from "../providers/types.js";

// Only the transport is replaced: the installed SDK request builders, SSE
// decoders and (for messages.stream) MessageStream accumulator all run for real.
const fetchMock = vi.fn<typeof fetch>();
const gateway = "https://offline.invalid/v1/?tenant=team%20a&tag=one&tag=two";
const params: StreamParams = {
  model: "gpt-4o",
  systemPrompt: "system",
  maxTokens: 128,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
};

function sse(data: object, named = false): string {
  return `${named ? `event: ${(data as { type: string }).type}\r\n` : ""}data: ${JSON.stringify(data)}\r\n\r\n`;
}

function sseResponse(wire: string): Response {
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  // Deliberately split field names, JSON, CRLF and multi-byte UTF-8 characters.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 7));
      offset = Math.min(offset + 7, bytes.length);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function anthropicStart(): string {
  return sse({ type: "message_start", message: {
    id: "msg_offline", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  } }, true);
}

function chatChunk(delta: object, finishReason: string | null = null): object {
  return { id: "chatcmpl_offline", object: "chat.completion.chunk", created: 1, model: "gpt-4o",
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

async function collect(provider: LLMProvider, signal?: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({ ...params, signal,
    model: provider.name === "anthropic" ? "claude-sonnet-4-6" : params.model })) events.push(event);
  return events;
}

function request(): { url: URL; init: RequestInit; body: Record<string, unknown>; headers: Headers } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(init?.method).toBe("POST");
  return { url: new URL(String(url)), init: init!, body: JSON.parse(String(init!.body)), headers: new Headers(init!.headers) };
}

beforeEach(() => {
  fetchMock.mockReset();
  // A missed fixture must fail locally, never fall through to a real fetch.
  fetchMock.mockImplementation(async () => { throw new Error("Unexpected offline SDK request"); });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://offline.invalid");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("real SDK SSE transport (Anthropic 0.131 / OpenAI 7.27)", () => {
  it("runs Anthropic messages.stream through its accumulator and preserves exact text/tool deltas", async () => {
    const wire = anthropicStart()
      + sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, true)
      + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } }, true)
      + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "café 🧪" } }, true)
      + sse({ type: "content_block_stop", index: 0 }, true)
      + sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_file", name: "read_file", input: {} } }, true)
      + sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } }, true)
      + sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } }, true)
      + sse({ type: "content_block_stop", index: 1 }, true)
      + sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } }, true)
      + sse({ type: "message_stop" }, true);
    fetchMock.mockResolvedValueOnce(sseResponse(wire));

    expect(await collect(new AnthropicProvider("offline-test-key"))).toEqual([
      { type: "message_start" },
      { type: "usage", inputTokens: 12, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 2 },
      { type: "text_delta", text: "Reading " }, { type: "text_delta", text: "café 🧪" },
      { type: "tool_call_start", toolCallId: "call_file", toolName: "read_file" },
      { type: "tool_call_delta", toolCallId: "call_file", argsJson: '{"path":' },
      { type: "tool_call_delta", toolCallId: "call_file", argsJson: '"a.ts"}' },
      { type: "tool_call_end", toolCallId: "call_file" },
      { type: "usage", inputTokens: 0, outputTokens: 8 },
      { type: "message_end", stopReason: "tool_use" },
    ]);
    const req = request();
    expect(req.url.href).toBe("https://offline.invalid/v1/messages");
    expect(req.headers.get("x-stainless-package-version")).toBe("0.131.0");
    expect(req.headers.get("x-stainless-helper-method")).toBe("stream");
    expect(req.body).toMatchObject({ stream: true, max_tokens: 128,
      tools: [{ name: "read_file", input_schema: params.tools![0]!.inputSchema, cache_control: { type: "ephemeral" } }] });
    expect(Anthropic.APIUserAbortError).toBeTypeOf("function");
  });

  it("runs OpenAI chat.completions.create, including usage-only chunks and the DONE sentinel", async () => {
    const wire = sse(chatChunk({ content: "Reading " }))
      + sse(chatChunk({ content: "café 🧪" }))
      + sse(chatChunk({ tool_calls: [{ index: 0, id: "call_file", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }))
      + sse(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }))
      + sse(chatChunk({}, "tool_calls"))
      + sse({ ...chatChunk({}), choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 3 } } })
      + "data: [DONE]\r\n\r\ndata: not-json-after-DONE\r\n\r\n";
    fetchMock.mockResolvedValueOnce(sseResponse(wire));
    expect(await collect(new OpenAIProvider("offline-test-key", "chat", { baseURL: gateway }))).toEqual([
      { type: "message_start" },
      { type: "text_delta", text: "Reading " }, { type: "text_delta", text: "café 🧪" },
      { type: "tool_call_start", toolCallId: "call_file", toolName: "read_file" },
      { type: "tool_call_delta", toolCallId: "call_file", argsJson: '{"path":' },
      { type: "tool_call_delta", toolCallId: "call_file", argsJson: '"a.ts"}' },
      { type: "tool_call_end", toolCallId: "call_file" },
      { type: "message_end", stopReason: "tool_calls" },
      { type: "usage", inputTokens: 12, outputTokens: 8, cacheReadTokens: 3 },
    ]);
    const req = request();
    expect(req.url.pathname).toBe("/v1/chat/completions");
    expect(req.url.searchParams.get("tenant")).toBe("team a");
    // 7.27 preserves repeated base-URL query parameters, not just the last one.
    expect(req.url.searchParams.getAll("tag")).toEqual(["one", "two"]);
    expect(req.headers.get("x-stainless-package-version")).toBe("7.27.0");
    expect(req.body).toMatchObject({ stream: true, max_completion_tokens: 128, stream_options: { include_usage: true } });
    expect(req.body).not.toHaveProperty("max_tokens");
  });

  it("runs OpenAI responses.create and maps output item IDs to function call IDs", async () => {
    const item = { id: "fc_item", type: "function_call", call_id: "call_file", name: "read_file", arguments: "", status: "in_progress" };
    const wire = sse({ type: "response.output_text.delta", item_id: "msg_text", output_index: 0, content_index: 0, delta: "café 🧪", sequence_number: 1 }, true)
      + sse({ type: "response.output_item.added", output_index: 1, item, sequence_number: 2 }, true)
      + sse({ type: "response.function_call_arguments.delta", item_id: "fc_item", output_index: 1, delta: '{"path":', sequence_number: 3 }, true)
      + sse({ type: "response.function_call_arguments.delta", item_id: "fc_item", output_index: 1, delta: '"a.ts"}', sequence_number: 4 }, true)
      + sse({ type: "response.output_item.done", output_index: 1, item: { ...item, arguments: '{"path":"a.ts"}', status: "completed" }, sequence_number: 5 }, true)
      + sse({ type: "response.completed", sequence_number: 6, response: { id: "resp_offline", object: "response", status: "completed", usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 3 } } } }, true);
    fetchMock.mockResolvedValueOnce(sseResponse(wire));
    expect(await collect(new OpenAIProvider("offline-test-key", "responses", { baseURL: gateway }))).toEqual([
      { type: "message_start" }, { type: "text_delta", text: "café 🧪" },
      { type: "tool_call_start", toolCallId: "call_file", toolName: "read_file" },
      { type: "tool_call_delta", toolCallId: "call_file", argsJson: '{"path":' },
      { type: "tool_call_delta", toolCallId: "call_file", argsJson: '"a.ts"}' },
      { type: "tool_call_end", toolCallId: "call_file" },
      { type: "usage", inputTokens: 12, outputTokens: 8, cacheReadTokens: 3 },
      { type: "message_end", stopReason: "completed" },
    ]);
    const req = request();
    expect(req.url.pathname).toBe("/v1/responses");
    expect(req.url.searchParams.get("tenant")).toBe("team a");
    expect(req.url.searchParams.getAll("tag")).toEqual(["one", "two"]);
    expect(req.body).toMatchObject({ stream: true, max_output_tokens: 128,
      tools: [{ type: "function", name: "read_file", strict: false }] });
  });
});

const transports = [
  { name: "Anthropic messages.stream", make: () => new AnthropicProvider("offline-test-key"), ErrorClass: Anthropic.APIUserAbortError },
  { name: "OpenAI chat.completions.create", make: () => new OpenAIProvider("offline-test-key", "chat", { baseURL: gateway }), ErrorClass: OpenAI.APIUserAbortError },
  { name: "OpenAI responses.create", make: () => new OpenAIProvider("offline-test-key", "responses", { baseURL: gateway }), ErrorClass: OpenAI.APIUserAbortError },
];

describe.each(transports)("$name cancellation", ({ name, make, ErrorClass }) => {
  it("rejects a pre-aborted request without calling fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(make(), controller.signal)).rejects.toBeInstanceOf(ErrorClass);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards caller cancellation to an open SSE body and stops without completing or retrying", async () => {
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const aborted = vi.fn();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      transportSignal = init!.signal!;
      const prefix = name.startsWith("Anthropic")
        ? anthropicStart()
          + sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, true)
          + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }, true)
        : name.includes("chat.") ? sse(chatChunk({ content: "partial" }))
        : sse({ type: "response.output_text.delta", item_id: "msg_text", output_index: 0, content_index: 0, delta: "partial", sequence_number: 1 }, true);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix));
          // Model fetch's response body failure on abort; no timers or network.
          transportSignal!.addEventListener("abort", () => {
            aborted();
            controller.error(new DOMException("Offline request aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const events: StreamEvent[] = [];
    const consume = async () => {
      for await (const event of make().stream({ ...params, signal: caller.signal,
        model: name.startsWith("Anthropic") ? "claude-sonnet-4-6" : params.model })) {
        events.push(event);
        if (event.type === "text_delta") caller.abort();
      }
    };
    // MessageStream surfaces user abort; OpenAI's raw SSE stream ends quietly.
    if (name.startsWith("Anthropic")) await expect(consume()).rejects.toBeInstanceOf(ErrorClass);
    else await expect(consume()).resolves.toBeUndefined();
    expect(transportSignal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "partial" }]);
    expect(events.some((event) => event.type === "message_end")).toBe(false);
  });
});
