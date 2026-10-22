import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MCPManager } from "../mcp/manager.js";
import type { MCPServerConfig } from "../mcp/types.js";

// Drives a remote MCP server over mocked JSON-RPC. The server exposes a fixed
// catalog; each test varies the per-server `tools` selection and asserts which
// tool definitions the manager surfaces (prefixed with the server name).
describe("MCP per-server tool selection", () => {
  let originalFetch: typeof globalThis.fetch;
  let manager: MCPManager;
  let stderr: ReturnType<typeof vi.spyOn>;
  const CATALOG = ["echo", "add", "subtract", "danger"];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    manager = new MCPManager();
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    manager.stopAll();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockServer(tools: string[] = CATALOG) {
    globalThis.fetch = vi.fn(async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      let result: unknown;
      switch (request.method) {
        case "initialize": result = { capabilities: {} }; break;
        case "notifications/initialized": return new Response(null, { status: 202 });
        case "tools/list":
          result = { tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
          break;
        default: throw new Error(`Unexpected RPC method: ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  const base = { type: "remote", transport: "http", url: "http://localhost/mcp" } as const;
  const names = () => manager.getToolDefinitions().map((d) => d.schema.name);

  it("exposes every tool when no selection is configured", async () => {
    mockServer();
    await manager.startServer("srv", base);
    expect(names()).toEqual(["srv__echo", "srv__add", "srv__subtract", "srv__danger"]);
  });

  it("exposes only the selected tools, preserving the server's order", async () => {
    mockServer();
    // Selection order differs from catalog order; the server's order wins.
    await manager.startServer("srv", { ...base, tools: ["add", "echo"] } as MCPServerConfig);
    expect(names()).toEqual(["srv__echo", "srv__add"]);
  });

  it("treats an empty selection as 'expose all' (the default)", async () => {
    mockServer();
    await manager.startServer("srv", { ...base, tools: [] } as MCPServerConfig);
    expect(names()).toEqual(["srv__echo", "srv__add", "srv__subtract", "srv__danger"]);
  });

  it("ignores unknown names but keeps the valid ones, and warns about the typo", async () => {
    mockServer();
    await manager.startServer("srv", { ...base, tools: ["echo", "nonexistent"] } as MCPServerConfig);
    expect(names()).toEqual(["srv__echo"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("not exposed by this server (ignored): nonexistent"));
  });

  it("falls back to all tools and warns when no selected name matches", async () => {
    mockServer();
    await manager.startServer("srv", { ...base, tools: ["bogus1", "bogus2"] } as MCPServerConfig);
    expect(names()).toEqual(["srv__echo", "srv__add", "srv__subtract", "srv__danger"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("none of the configured tools matched"));
  });

  it("matches on the unprefixed name as the server reports it", async () => {
    mockServer();
    // A selection written with the Agav prefix should NOT match — selection is
    // against the server's own names, keeping configuration portable.
    await manager.startServer("srv", { ...base, tools: ["srv__echo"] } as MCPServerConfig);
    expect(names()).toEqual(["srv__echo", "srv__add", "srv__subtract", "srv__danger"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("none of the configured tools matched"));
  });

  it("re-applies the selection when the server's catalog changes", async () => {
    // The selection lives in fetchTools(), the single path used by both the
    // initial handshake and list_changed refreshes. Restarting against a changed
    // catalog exercises that same re-fetch: a newly added tool outside the
    // selection stays hidden, and a now-missing selected tool drops out.
    mockServer(["echo", "add"]);
    await manager.startServer("srv", { ...base, tools: ["echo", "subtract"] } as MCPServerConfig);
    // 'subtract' not in catalog yet → only echo; warning emitted.
    expect(names()).toEqual(["srv__echo"]);

    // Catalog now includes 'subtract' and a new unselected 'multiply'.
    mockServer(["echo", "add", "subtract", "multiply"]);
    await manager.startServer("srv", { ...base, tools: ["echo", "subtract"] } as MCPServerConfig);
    expect(names()).toEqual(["srv__echo", "srv__subtract"]);
  });

  it("applies the selection independently per server", async () => {
    mockServer();
    await manager.startServer("a", { ...base, tools: ["echo"] } as MCPServerConfig);
    await manager.startServer("b", { ...base, tools: ["add", "subtract"] } as MCPServerConfig);
    expect(names().sort()).toEqual(["a__echo", "b__add", "b__subtract"].sort());
  });

  it.each([
    { label: "a bare string", value: "echo" },
    { label: "a number", value: 3 },
    { label: "an object", value: { echo: true } },
    { label: "an array with a non-string entry", value: ["echo", 7] },
  ])("does not crash on malformed tools config ($label): warns and exposes all", async ({ value }) => {
    mockServer();
    // A malformed value must not throw during startup and drop the server
    // (which would also lose its resources and prompts) — expose all instead.
    await expect(
      manager.startServer("srv", { ...base, tools: value } as unknown as MCPServerConfig),
    ).resolves.toBeDefined();
    expect(names()).toEqual(["srv__echo", "srv__add", "srv__subtract", "srv__danger"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('invalid "tools" config'));
  });
});
