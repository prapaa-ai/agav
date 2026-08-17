import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  type: "service_account",
  project_id: "test-project",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "agav@test-project.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});

import { VertexAIAuth, VertexAIProvider, fetchVertexAIModels } from "../providers/vertex-ai.js";

let testDir: string;
let credentialsPath: string;

describe("VertexAIProvider", () => {
  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agav-vertex-test-"));
    credentialsPath = join(testDir, "service-account.json");
    await writeFile(credentialsPath, serviceAccount);
  });
  afterAll(async () => rm(testDir, { recursive: true, force: true }));
  beforeEach(() => vi.restoreAllMocks());

  it("reports every missing required service-account key", async () => {
    const incompleteCredentialsPath = join(testDir, "incomplete-service-account.json");
    await writeFile(incompleteCredentialsPath, JSON.stringify({ type: "service_account", project_id: "" }));

    await expect(new VertexAIAuth(incompleteCredentialsPath).getProjectId()).rejects.toThrow(
      "missing required keys: project_id, private_key, client_email",
    );
  });

  it("reports an invalid service-account type separately", async () => {
    const invalidTypeCredentialsPath = join(testDir, "invalid-type-service-account.json");
    await writeFile(invalidTypeCredentialsPath, JSON.stringify({
      type: "authorized_user",
      project_id: "test-project",
      private_key: "key",
      client_email: "user@example.com",
    }));

    await expect(new VertexAIAuth(invalidTypeCredentialsPath).getProjectId()).rejects.toThrow(
      'key "type" must be "service_account" (received "authorized_user")',
    );
  });

  it("authenticates with the service account and streams chat/tool/usage events", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"hello ","tool_calls":[{"index":0,"id":"call_1","extra_content":{"google":{"thought_signature":"opaque-signature"}},"function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}',
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const events = [];
    const provider = new VertexAIProvider(credentialsPath);
    for await (const event of provider.stream({
      model: "vertex/gemini-2.5-flash",
      systemPrompt: "system",
      effort: "high",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }],
    })) events.push(event);

    expect(events).toEqual([
      { type: "message_start" },
      { type: "text_delta", text: "hello " },
      { type: "tool_call_start", toolCallId: "call_1", toolName: "lookup" },
      { type: "tool_call_delta", toolCallId: "call_1", argsJson: '{"q":', providerMetadata: { vertexAIThoughtSignature: "opaque-signature" } },
      { type: "usage", inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 },
      { type: "tool_call_delta", toolCallId: "call_1", argsJson: '"x"}' },
      { type: "tool_call_end", toolCallId: "call_1" },
      { type: "message_end", stopReason: "tool_calls" },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    const request = fetchMock.mock.calls[1]!;
    expect(request[0]).toBe("https://aiplatform.googleapis.com/v1beta1/projects/test-project/locations/global/endpoints/openapi/chat/completions");
    const body = JSON.parse(String(request[1]?.body));
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream_options).toEqual({ include_usage: true });

    for await (const _event of provider.stream({
      model: "vertex/gemini-2.5-flash",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{
          type: "tool_use",
          toolCallId: "call_1",
          toolName: "lookup",
          toolInput: { q: "x" },
          providerMetadata: { vertexAIThoughtSignature: "opaque-signature" },
        }] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", toolResult: "result" }] },
      ],
    })) {}
    const followUpBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(followUpBody.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe("opaque-signature");
  });

  it("uses Vertex's compatibility sentinel for legacy history without stored signatures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n', { status: 200 }));

    for await (const _event of new VertexAIProvider(credentialsPath).stream({
      model: "vertex/gemini-3.5-flash",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", toolCallId: "old", toolName: "overview", toolInput: {} }] },
        { role: "user", content: [{ type: "tool_result", toolCallId: "old", toolResult: "result" }] },
      ],
    })) {}
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.messages[0].tool_calls[0].extra_content.google.thought_signature).toBe("skip_thought_signature_validator");
  });

  it("repairs unsigned parallel calls once when Vertex rejects the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Function call is missing a thought_signature in functionCall parts." } }), { status: 400 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n', { status: 200 }));

    for await (const _event of new VertexAIProvider(credentialsPath).stream({
      model: "vertex/gemini-3.5-flash",
      messages: [
        { role: "assistant", content: [
          {
            type: "tool_use",
            toolCallId: "first",
            toolName: "overview",
            toolInput: {},
            providerMetadata: { vertexAIThoughtSignature: "real-signature" },
          },
          { type: "tool_use", toolCallId: "second", toolName: "read_file", toolInput: { path: "x" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", toolCallId: "first", toolResult: "one" },
          { type: "tool_result", toolCallId: "second", toolResult: "two" },
        ] },
      ],
    })) {}

    const firstBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const repairedBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(firstBody.messages[0].tool_calls[0].extra_content.google.thought_signature).toBe("real-signature");
    expect(firstBody.messages[0].tool_calls[1].extra_content).toBeUndefined();
    expect(repairedBody.messages[0].tool_calls[0].extra_content.google.thought_signature).toBe("real-signature");
    expect(repairedBody.messages[0].tool_calls[1].extra_content.google.thought_signature).toBe("skip_thought_signature_validator");
  });

  it("streams Claude models through Vertex's Anthropic endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking"}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"lookup","input":{}}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":1}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
        "",
      ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const events = [];
    for await (const event of new VertexAIProvider(credentialsPath).stream({
      model: "vertex/claude-sonnet-4-5@20250929",
      systemPrompt: "system",
      effort: "high",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }],
    })) events.push(event);

    expect(events).toEqual([
      { type: "message_start" },
      { type: "usage", inputTokens: 12, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 2 },
      { type: "text_delta", text: "Checking" },
      { type: "tool_call_start", toolCallId: "tool_1", toolName: "lookup" },
      { type: "tool_call_delta", toolCallId: "tool_1", argsJson: '{"q":"x"}' },
      { type: "tool_call_end", toolCallId: "tool_1" },
      { type: "usage", inputTokens: 0, outputTokens: 7 },
      { type: "message_end", stopReason: "tool_use" },
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/anthropic/models/claude-sonnet-4-5%4020250929:streamRawPredict",
    );
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.model).toBeUndefined();
    expect(body.anthropic_version).toBe("vertex-2023-10-16");
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.system[0]).toMatchObject({ text: "system", cache_control: { type: "ephemeral" } });
    expect(body.tools[0]).toMatchObject({ name: "lookup", cache_control: { type: "ephemeral" } });
  });

  it("lists and normalizes Gemini and Claude publisher models", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        publisherModels: [
          { name: "publishers/google/models/gemini-2.5-flash@001" },
          { name: "publishers/google/models/gemini-2.5-flash-preview-tts" },
          { name: "publishers/google/models/imagen-4.0" },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        publisherModels: [
          { name: "publishers/anthropic/models/claude-sonnet-4-5@20250929" },
          { name: "publishers/anthropic/models/not-claude" },
        ],
      }), { status: 200 }));

    await expect(fetchVertexAIModels(credentialsPath)).resolves.toEqual([
      "vertex/claude-sonnet-4-5@20250929",
      "vertex/gemini-2.5-flash",
    ]);
  });
});
