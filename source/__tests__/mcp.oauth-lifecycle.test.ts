import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), callbacks: [] as Array<(active: boolean) => void> }));
vi.mock("../mcp/oauth.js", () => ({
  MCPOAuthError: class extends Error {},
  MCPAuthenticationRequiredError: class extends Error {},
  MCPOAuth: class {
    constructor(_name: string, _config: unknown, _interactive: boolean, callback: (active: boolean) => void) { mocks.callbacks.push(callback); }
    fetch = mocks.fetch;
  },
}));
import { MCPClient } from "../mcp/client.js";
import { MCPManager } from "../mcp/manager.js";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocks.callbacks.length = 0; mocks.fetch.mockReset(); });

describe("OAuth MCP lifecycle", () => {
  it("pauses the normal RPC timeout during authorization then resumes it", async () => {
    vi.useFakeTimers();
    const client = new MCPClient("figma", { url: "https://mcp.figma.com/mcp", transport: "http" });
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const start = client.start();
    mocks.callbacks[0]!(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((client as any).pending.size).toBe(1);
    mocks.callbacks[0]!(false);
    finish(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }), { headers: { "content-type": "application/json" } }));
    // Allow initialize to settle, then stop while the next message remains in flight.
    await vi.advanceTimersByTimeAsync(1);
    client.stop();
    finish(new Response(null, { status: 202 }));
    await expect(start).rejects.toThrow();
    expect((client as any).pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not let an unmatched authorization end prevent new request timers", async () => {
    vi.useFakeTimers();
    const client = new MCPClient("test", { url: "https://example.com/mcp", transport: "http" });
    mocks.callbacks[0]!(false);
    expect((client as any).authorizationWaits).toBe(0);
    mocks.fetch.mockImplementation(() => new Promise<Response>(() => {}));
    const start = client.start();
    const rejection = expect(start).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopAll aborts an MCP server still authenticating", async () => {
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const manager = new MCPManager();
    const start = manager.startServer("figma", { url: "https://mcp.figma.com/mcp", transport: "http" });
    const assertion = expect(start).rejects.toThrow("stopped");
    manager.stopAll();
    await assertion;
    expect(manager.getServerNames()).toEqual([]);
  });
});
