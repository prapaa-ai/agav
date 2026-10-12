import { EventEmitter } from "node:events";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import { useAgent } from "../hooks/use-agent.js";
import { MCPManager } from "../mcp/manager.js";
import { MCPAuthenticationRequiredError } from "../mcp/oauth.js";
import { CommandRegistry } from "../commands/registry.js";
import type { AgavConfig } from "../config/config.js";
import type { CommandContext } from "../commands/types.js";
vi.mock("../plugins/loader.js", () => ({ loadPlugins: async () => [] }));
vi.mock("../skills/loader.js", () => ({ loadSkills: async () => [], getCachedSkills: () => [] }));
vi.mock("../skills/improvement.js", () => ({ maybeRunBackgroundImprovement: async () => {} }));
vi.mock("../agent/planner.js", () => ({ setPlanScope: vi.fn(), ensurePlanFile: async () => {}, clearPlan: async () => {}, loadPlan: async () => null, prunePlans: async () => {}, isPlanActive: () => false }));
afterEach(() => vi.restoreAllMocks());

describe("explicit MCP startup authentication", () => {
  it.each([0, 1, 5])("renders exactly one aggregated warning for %i servers (zero means none)", async count => {
    const names = Array.from({ length: count }, (_, i) => `server-${i}`);
    vi.spyOn(MCPManager.prototype, "startServer").mockImplementation(async name => {
      if (names.includes(name)) throw new MCPAuthenticationRequiredError("requires login");
      return [];
    });
    vi.spyOn(MCPManager.prototype, "getAuthenticationRequired").mockReturnValue(names);
    vi.spyOn(MCPManager.prototype, "getServerNames").mockReturnValue(["public"]);
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
    const config = { model: "mock", mcpServers: Object.fromEntries([...names, "public"].map(name => [name, { url: `https://${name}.example/mcp` }])) } as unknown as AgavConfig;
    let agent!: ReturnType<typeof useAgent>;
    function App() { agent = useAgent(null, config); return null; }
    const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    try {
      for (let i = 0; i < 100; i++) {
        await instance.waitUntilRenderFlush();
        if (agent.mcpServers.includes("public")) break;
      }
      expect(agent.mcpServers).toEqual(["public"]);
      const warnings = agent.messages.filter(message => message.content.includes("require") && message.content.includes("authentication"));
      expect(warnings).toHaveLength(count ? 1 : 0);
      if (count) expect(warnings[0]!.content).toBe(`Warning: ${count} MCP server${count === 1 ? " requires" : "s require"} authentication. Run /mcp to view them, then /mcp auth <name> to sign in.`);
      expect(stderr.mock.calls.some(([text]) => String(text).includes("failed to start"))).toBe(false);
      if (count) {
        vi.spyOn(MCPManager.prototype, "authenticateServer").mockImplementation(async name => { names.splice(names.indexOf(name), 1); });
        await agent.authenticateMCPServer("server-0");
        for (let i = 0; i < 20; i++) await instance.waitUntilRenderFlush();
        const updated = agent.messages.filter(message => message.id === "mcp-auth-warning");
        expect(updated).toHaveLength(count > 1 ? 1 : 0);
        if (count > 1) expect(updated[0]!.content).toContain(`${count - 1} MCP servers require authentication`);
      }
    } finally { instance.unmount(); }
  });

  it("logout immediately removes only that server's tools and prompt commands from the live hook", async () => {
    let connected = true;
    vi.spyOn(MCPManager.prototype, "startServer").mockResolvedValue([]);
    vi.spyOn(MCPManager.prototype, "getServerNames").mockImplementation(() => connected ? ["linear", "other"] : ["other"]);
    vi.spyOn(MCPManager.prototype, "getAuthenticationRequired").mockImplementation(() => connected ? [] : ["linear"]);
    vi.spyOn(MCPManager.prototype, "getToolDefinitions").mockImplementation(() => (connected ? ["linear", "other"] : ["other"]).map(name => ({
      schema: { name: `${name}__list`, description: "list", inputSchema: {} }, mcpServerName: name, execute: async () => ({ output: "ok", isError: false }),
    })));
    vi.spyOn(MCPManager.prototype, "getAllPrompts").mockImplementation(() => connected ? [{ name: "linear__prompt", serverName: "linear" }] : []);
    vi.spyOn(MCPManager.prototype, "logoutServer").mockImplementation(async () => { connected = false; });
    vi.spyOn(MCPManager.prototype, "authenticateServer").mockImplementation(async () => { connected = true; });
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
    let agent!: ReturnType<typeof useAgent>;
    const config = { model: "mock", mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } } as unknown as AgavConfig;
    function App() { agent = useAgent(null, config); return null; }
    const instance = render(createElement(App), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    try {
      for (let i = 0; i < 100; i++) { await instance.waitUntilRenderFlush(); if (agent.mcpServers.length) break; }
      expect(agent.toolRegistry.get("linear__list")).toBeDefined();
      expect(agent.mcpPromptCommands).toHaveLength(1);
      expect(agent.messages.filter(message => message.id === "mcp-auth-warning")).toEqual([]);
      await agent.logoutMCPServer("linear");
      for (let i = 0; i < 20; i++) await instance.waitUntilRenderFlush();
      expect(agent.toolRegistry.get("linear__list")).toBeUndefined();
      expect(agent.toolRegistry.get("other__list")).toBeDefined();
      expect(agent.mcpPromptCommands).toEqual([]);
      expect(agent.mcpServers).toEqual(["other"]);
      const warnings = () => agent.messages.filter(message => message.id === "mcp-auth-warning");
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]!.content).toBe("Warning: 1 MCP server requires authentication. Run /mcp to view them, then /mcp auth <name> to sign in.");
      await agent.logoutMCPServer("linear");
      for (let i = 0; i < 20; i++) await instance.waitUntilRenderFlush();
      expect(warnings()).toHaveLength(1);
      await agent.authenticateMCPServer("linear");
      for (let i = 0; i < 20; i++) await instance.waitUntilRenderFlush();
      expect(warnings()).toEqual([]);
      expect(agent.toolRegistry.get("linear__list")).toBeDefined();
      await expect(agent.logoutMCPServer("unknown")).rejects.toThrow("not a configured remote server");
    } finally { instance.unmount(); }
  });

  it("lists pending servers and only authenticates on an explicit command", async () => {
    const auth = vi.fn(async () => {});
    const context = { getDebugState: () => ({ mcpServers: ["public"] }), getMCPAuthenticationRequired: () => ["linear", "notion"], authenticateMCPServer: auth, showStatus: vi.fn() } as unknown as CommandContext;
    const registry = new CommandRegistry();
    expect(await registry.execute("/mcp", context)).toEqual({ type: "message", text: "Connected MCP servers: public\nAuthentication required: linear, notion\nRun /mcp auth <name> to sign in. Only this explicit action opens your browser." });
    expect(auth).not.toHaveBeenCalled();
    await registry.execute("/mcp auth linear", context);
    expect(auth).toHaveBeenCalledExactlyOnceWith("linear");
  });
});
