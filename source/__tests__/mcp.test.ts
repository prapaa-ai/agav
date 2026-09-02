import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MCPClient } from "../mcp/client.js";

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
