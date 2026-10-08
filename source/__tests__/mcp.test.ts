import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MCPClient } from "../mcp/client.js";
import { MCPManager } from "../mcp/manager.js";
import { ToolRegistry } from "../tools/registry.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import type { LLMProvider, StreamParams } from "../providers/types.js";

// Exercise the public APIs with JSON-RPC replies, rather than mocking callTool.
describe("MCP tool result status", () => {
  let originalFetch: typeof globalThis.fetch;
  let client: MCPClient;
  let manager: MCPManager;
  const config = { type: "remote", transport: "http", url: "http://localhost/mcp" } as const;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    client = new MCPClient("test", config);
    manager = new MCPManager();
  });

  afterEach(() => {
    client.stop();
    manager.stopAll();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockRpc(reply: Record<string, unknown>) {
    const calls = vi.fn();
    globalThis.fetch = vi.fn(async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      let result: unknown;
      switch (request.method) {
        case "initialize": result = { capabilities: {} }; break;
        case "notifications/initialized": return new Response(null, { status: 202 });
        case "tools/list": result = { tools: [{ name: "operate", inputSchema: { type: "object", properties: {} } }] }; break;
        case "tools/call": calls(request.params); break;
        default: throw new Error(`Unexpected RPC method: ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        ...(request.method === "tools/call" ? reply : { result }),
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return calls;
  }

  it.each([
    { label: "missing flag", result: { content: [{ type: "text", text: "ok" }] }, output: "ok", isError: false },
    { label: "false flag", result: { isError: false, content: [{ type: "text", text: "ok" }] }, output: "ok", isError: false },
    { label: "true flag and joined text", result: { isError: true, content: [{ type: "text", text: "failed" }, { type: "text", text: "details" }] }, output: "failed\ndetails", isError: true },
    { label: "empty content", result: { isError: true, content: [] }, output: "", isError: true },
    { label: "missing content", result: { isError: true }, output: "No output", isError: true },
    { label: "empty text", result: { content: [{ type: "text" }, { type: "text", text: "next" }] }, output: "\nnext", isError: false },
    { label: "existing non-text rendering", result: { isError: true, content: [
      { type: "image", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///note", text: "note" } },
      { type: "resource_link", uri: "file:///link" },
      { type: "other" },
    ] }, output: "[Image content omitted: image/png]\n[Resource: file:///note]\nnote\n[Resource link: file:///link]\n[Unsupported content type: other]", isError: true },
  ])("preserves $label through client, manager and registry", async ({ result, output, isError }) => {
    const calls = mockRpc({ result });
    await client.start();
    await manager.startServer("test", config);
    const expected = { output, isError };
    await expect(client.callTool("test__operate", { value: 1 })).resolves.toEqual(expected);
    const definition = manager.getToolDefinitions()[0]!;
    await expect(definition.execute({ value: 1 })).resolves.toEqual(expected);
    const registry = new ToolRegistry();
    registry.register(definition);
    await expect(registry.execute("test__operate", { value: 1 })).resolves.toEqual(expected);
    expect(calls.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ name: "operate", arguments: { value: 1 } }]));
  });

  it.each(["rpc", "transport"] as const)("keeps %s failures distinct from resolved tool errors", async (failure) => {
    const calls = mockRpc({ error: { code: -32603, message: "RPC failed" } });
    await client.start();
    await manager.startServer("test", config);
    const error = failure === "rpc" ? "RPC failed" : "Network failed";
    if (failure === "transport") globalThis.fetch = vi.fn().mockRejectedValue(new Error(error));
    await expect(client.callTool("operate", {})).rejects.toThrow(error);
    const definition = manager.getToolDefinitions()[0]!;
    await expect(definition.execute({})).resolves.toEqual({ output: error, isError: true });
    const registry = new ToolRegistry();
    registry.register(definition);
    await expect(registry.execute("test__operate", {})).resolves.toEqual({ output: error, isError: true });
    if (failure === "rpc") expect(calls).toHaveBeenCalledTimes(3);
    else expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("forwards cancellation without stopping the shared server or retrying", async () => {
    const calls = mockRpc({ result: { content: [{ type: "text", text: "ok" }] } });
    await manager.startServer("test", config);
    const definition = manager.getToolDefinitions()[0]!;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    // The RPC send stays in flight; abort must settle only this request's wait.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const pending = definition.execute({}, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ output: "MCP request cancelled.", isError: true });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    const sends = fetchMock.mock.calls.length;
    await expect(definition.execute({}, { signal: controller.signal })).resolves.toEqual({ output: "MCP request cancelled.", isError: true });
    expect(fetchMock).toHaveBeenCalledTimes(sends);
    await expect(definition.execute({})).resolves.toEqual({ output: "ok", isError: false });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(manager.getServerNames()).toEqual(["test"]);
  });

  it("retains tool-level failure in agent events and model tool history without retries", async () => {
    const calls = mockRpc({ result: { isError: true, content: [{ type: "text", text: "Operation failed" }] } });
    await manager.startServer("test", config);
    const registry = new ToolRegistry();
    registry.register(manager.getToolDefinitions()[0]!);
    const conversation = new ConversationState();
    conversation.addUserMessage("operate");
    let turn = 0;
    const stream = vi.fn(async function* (params: StreamParams) {
      if (turn++ === 0) {
        yield { type: "tool_call_start", toolCallId: "call-1", toolName: "test__operate" } as const;
        yield { type: "tool_call_delta", toolCallId: "call-1", argsJson: "{}" } as const;
        yield { type: "message_end", stopReason: "tool_calls" } as const;
      } else {
        expect(params.messages.flatMap(message => message.content)).toContainEqual({
          type: "tool_result", toolCallId: "call-1", toolResult: "Operation failed", isError: true,
        });
        yield { type: "text_delta", text: "Failed." } as const;
        yield { type: "message_end", stopReason: "end_turn" } as const;
      }
    });
    const provider: LLMProvider = { name: "mock", stream };
    const events = [];
    for await (const event of runAgentLoop({ provider, conversation, toolRegistry: registry, model: "m",
      permissionMode: "auto-accept", iterationsBudget: { remaining: 3, total: 3 },
    })) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", toolCallId: "call-1", output: "Operation failed", isError: true }));
    expect(calls).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: "turn_complete" });
  });
});

describe("mcp/client remote/SSE", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("successfully connects, performs handshake, and fetches tools from a remote SSE MCP server", async () => {
    const sseChunks = [
      "event: endpoint\ndata: http://localhost:29979/mcp/post\n\n",
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{"listChanged":true}},"protocolVersion":"2024-11-05","serverInfo":{"name":"test-server","version":"1.0.0"}}}\n\n',
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"test_tool","description":"A test tool","inputSchema":{"type":"object","properties":{}}}]}}\n\n'
    ];

    let chunkIndex = 0;
    let sseResolve: ((v: any) => void) | null = null;

    const mockReader = {
      read: async () => {
        if (chunkIndex === 0) {
          const chunk = sseChunks[chunkIndex++];
          const encoder = new TextEncoder();
          return { done: false, value: encoder.encode(chunk) };
        }

        if (chunkIndex >= sseChunks.length) {
          return { done: true, value: undefined };
        }

        // Wait until a POST request triggers the next chunk
        await new Promise<void>((resolve) => {
          sseResolve = resolve;
        });

        const chunk = sseChunks[chunkIndex++];
        const encoder = new TextEncoder();
        return { done: false, value: encoder.encode(chunk) };
      },
      releaseLock: () => {},
    };

    const mockBody = {
      getReader: () => mockReader,
    };

    const fetchMock = vi.fn().mockImplementation(async (url, options) => {
      if (options?.method === "POST") {
        // Trigger the next chunk in the next tick
        setTimeout(() => {
          if (sseResolve) {
            const resolve = sseResolve;
            sseResolve = null;
            resolve(undefined);
          }
        }, 10);
        return {
          ok: true,
          status: 200,
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: mockBody,
      };
    });

    globalThis.fetch = fetchMock as any;

    const client = new MCPClient("test-server", {
      type: "remote",
      transport: "sse",
      url: "http://localhost:29979/mcp",
    });

    await client.start();

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:29979/mcp", expect.any(Object));
    expect(client.getTools()).toEqual([
      {
        name: "test-server__test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
        serverName: "test-server",
      },
    ]);

    client.stop();
  });

  it("connects over Streamable HTTP (POST /mcp), carries the session id, and fetches tools", async () => {
    // Each POST returns an SSE-framed body with the JSON-RPC reply for that request's id.
    const sseFrame = (obj: unknown) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
    const sessionId = "sess-abc-123";
    const seenSessionIds: (string | null)[] = [];
    const postedMethods: string[] = [];

    const makeSseResponse = (body: string, extraHeaders: Record<string, string> = {}) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream", ...extraHeaders }),
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: new TextEncoder().encode(body) };
            },
            releaseLock: () => {},
          };
        },
      },
    });

    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      const msg = JSON.parse(options.body);
      postedMethods.push(msg.method);
      seenSessionIds.push(options.headers["Mcp-Session-Id"] ?? null);

      if (msg.method === "initialize") {
        return makeSseResponse(
          sseFrame({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "paper-desktop", version: "0.5.6" },
            },
          }),
          { "mcp-session-id": sessionId },
        );
      }
      if (msg.method === "notifications/initialized") {
        return { ok: true, status: 202, headers: new Headers(), text: async () => "" };
      }
      if (msg.method === "tools/list") {
        return makeSseResponse(
          sseFrame({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [{ name: "get_guide", description: "Load the guide", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
      }
      throw new Error(`unexpected method ${msg.method}`);
    });

    globalThis.fetch = fetchMock as any;

    const client = new MCPClient("paper", {
      type: "remote",
      transport: "http",
      url: "http://127.0.0.1:29979/mcp",
    });

    await client.start();

    // Every request is a POST to the base URL.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:29979/mcp",
      expect.objectContaining({ method: "POST" }),
    );
    // Session id is captured from initialize and echoed on later requests.
    expect(postedMethods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(seenSessionIds[0]).toBeNull();
    expect(seenSessionIds[postedMethods.indexOf("tools/list")]).toBe(sessionId);
    expect(client.getTools()).toEqual([
      {
        name: "paper__get_guide",
        description: "Load the guide",
        inputSchema: { type: "object", properties: {} },
        serverName: "paper",
      },
    ]);

    client.stop();
  });

  it("auto-detects: falls back to SSE when Streamable HTTP init fails", async () => {
    // The legacy SSE stream is a queue of frames drained one-per-read(). The first read returns
    // the endpoint event immediately; subsequent reads block until a POST enqueues the reply
    // for that request's id (robust to the extra id consumed by the Streamable HTTP probe).
    const frameQueue: string[] = ["event: endpoint\ndata: http://localhost:8080/post\n\n"];
    let deliverResolve: (() => void) | null = null;

    const mockReader = {
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (frameQueue.length === 0) {
          await new Promise<void>((r) => { deliverResolve = r; });
        }
        const frame = frameQueue.shift();
        if (frame === undefined) return { done: true, value: undefined };
        return { done: false, value: new TextEncoder().encode(frame) };
      },
      releaseLock: () => {},
    };

    const queueFrame = (obj: unknown) => {
      frameQueue.push(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
      if (deliverResolve) { const r = deliverResolve; deliverResolve = null; r(); }
    };

    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      if (options?.method === "POST") {
        const msg = JSON.parse(options.body);
        const acceptsStream = String(options.headers?.["Accept"] ?? "").includes("text/event-stream");
        // Streamable HTTP probe: initialize POST asks for event-stream and gets a 404, so
        // auto-detect abandons HTTP and falls back to the legacy SSE transport.
        if (msg.method === "initialize" && acceptsStream) {
          return { ok: false, status: 404, statusText: "Not Found", headers: new Headers(), text: async () => "" };
        }
        // SSE transport POSTs. Requests (with an id) get a matching reply on the GET stream;
        // notifications have no reply.
        if (msg.id != null) {
          if (msg.method === "initialize") {
            queueFrame({
              jsonrpc: "2.0",
              id: msg.id,
              result: { capabilities: {}, protocolVersion: "2024-11-05", serverInfo: { name: "legacy", version: "1.0.0" } },
            });
          } else if (msg.method === "tools/list") {
            queueFrame({
              jsonrpc: "2.0",
              id: msg.id,
              result: { tools: [{ name: "legacy_tool", description: "legacy", inputSchema: { type: "object", properties: {} } }] },
            });
          }
        }
        return { ok: true, status: 200, headers: new Headers(), text: async () => "" };
      }
      // GET establishes the legacy SSE stream.
      return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: { getReader: () => mockReader } };
    });

    globalThis.fetch = fetchMock as any;

    const client = new MCPClient("legacy", { type: "remote", url: "http://localhost:8080/mcp" });
    await client.start();

    expect(client.getTools()).toEqual([
      {
        name: "legacy__legacy_tool",
        description: "legacy",
        inputSchema: { type: "object", properties: {} },
        serverName: "legacy",
      },
    ]);

    client.stop();
  });
});
