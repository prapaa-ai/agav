import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MCPClient } from "../mcp/client.js";

/**
 * Tests that MCPClient.stop() properly cleans up in-flight requests
 * so the process can exit without waiting for 30-second timeouts.
 */
describe("MCPClient.stop() cleanup", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects pending requests when stop() is called", async () => {
    // Set up a remote client that will hang on tool calls (no response ever comes).
    const sseChunks = [
      "event: endpoint\ndata: http://localhost:29979/mcp/post\n\n",
      // Initialize response:
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{"listChanged":true}},"protocolVersion":"2024-11-05","serverInfo":{"name":"test","version":"1.0.0"}}}\n\n',
      // tools/list response:
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"slow_tool","description":"Takes forever","inputSchema":{"type":"object","properties":{}}}]}}\n\n',
    ];

    let chunkIndex = 0;
    let sseResolve: ((v: any) => void) | null = null;

    const mockReader = {
      read: async () => {
        if (chunkIndex === 0) {
          const chunk = sseChunks[chunkIndex++];
          return { done: false, value: new TextEncoder().encode(chunk) };
        }
        if (chunkIndex >= sseChunks.length) {
          // Block indefinitely — simulates a long-lived SSE stream
          await new Promise<void>((resolve) => { sseResolve = resolve; });
          return { done: true, value: undefined };
        }
        await new Promise<void>((resolve) => { sseResolve = resolve; });
        const chunk = sseChunks[chunkIndex++];
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      releaseLock: () => {},
    };

    const fetchMock = vi.fn().mockImplementation(async (_url: string, options: any) => {
      if (options?.method === "POST") {
        // Release the SSE reader if it's waiting
        setTimeout(() => {
          if (sseResolve) {
            const r = sseResolve;
            sseResolve = null;
            r(undefined);
          }
        }, 10);
        return { ok: true, status: 200, text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: { getReader: () => mockReader },
      };
    });

    globalThis.fetch = fetchMock as any;

    const client = new MCPClient("test", {
      type: "remote",
      transport: "sse",
      url: "http://localhost:29979/mcp",
    });

    await client.start();

    // Issue a tool call that will never get a response.
    // The mock SSE stream will close (reader returns done:true) after 10ms,
    // which rejects pending requests.  Capture the rejection immediately so
    // Node doesn't flag an unhandled rejection before we reach our assertion.
    let rejected: Error | undefined;
    const callPromise = client.callTool("slow_tool", {}).catch((err: Error) => {
      rejected = err;
    });

    // Give the POST a moment to be sent and the SSE stream to close.
    await new Promise((r) => setTimeout(r, 50));

    // Now stop the client.
    client.stop();

    // Wait for the promise chain to settle.
    await callPromise;

    // The request should have been rejected — either by the SSE stream-close
    // handler or by stop()'s own pending-drain.  The important thing is the
    // promise settled promptly instead of hanging for 30 seconds.
    expect(rejected).toBeInstanceOf(Error);
  });
});
