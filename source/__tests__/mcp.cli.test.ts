import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), disconnect: vi.fn(), config: vi.fn() }));
vi.mock("../mcp/oauth.js", () => ({ MCPOAuth: class { auth = mocks.auth; disconnect = mocks.disconnect; } }));
vi.mock("../config/config.js", async original => ({ ...await original<typeof import("../config/config.js")>(), loadConfig: mocks.config }));
import { runMCPCommand } from "../cli/mcp-cli.js";
import { parseArgs, main } from "../main.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockResolvedValue({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp" }, local: { command: "node" } } });
  mocks.auth.mockResolvedValue(undefined); mocks.disconnect.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("MCP authentication CLI", () => {
  it("parses commands without treating MCP as a prompt", () => {
    expect(parseArgs(["mcp", "auth", "figma"])).toMatchObject({ mcp: true, mcpCommand: "auth", _: ["auth", "figma"] });
  });
  it.each(["auth", "logout"])("dispatches %s without an LLM provider", async command => {
    const argv = process.argv;
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    process.argv = [process.execPath, "agav", "mcp", command, "figma"];
    try { await main(); } finally { process.argv = argv; }
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(command === "auth" ? mocks.auth : mocks.disconnect).toHaveBeenCalledOnce();
  });
  it("authenticates and removes its signal handlers", async () => {
    const count = process.listenerCount("SIGINT");
    expect(await runMCPCommand("auth", ["figma"])).toBe(0);
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(process.listenerCount("SIGINT")).toBe(count);
    expect(console.log).toHaveBeenCalledWith('Authenticated MCP server "figma". Restart Agav to connect.');
  });
  it("cancels sign-in on Ctrl+C", async () => {
    mocks.auth.mockImplementation(async (signal: AbortSignal) => {
      process.emit("SIGINT"); signal.throwIfAborted();
    });
    expect(await runMCPCommand("auth", ["figma"])).toBe(1);
    expect(console.error).toHaveBeenCalledWith("MCP OAuth login cancelled.");
    expect(console.log).not.toHaveBeenCalled();
  });
  it.each([["auth", []], ["logout", ["figma", "extra"]], ["bad", ["figma"]], ["auth", ["unknown"]], ["auth", ["local"]]])("rejects invalid command %s %j", async (command, args) => {
    expect(await runMCPCommand(command as string, args as string[])).toBe(1);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.disconnect).not.toHaveBeenCalled();
  });
  it.each(["denied", "timed out", "registration denied"])("does not print success on %s", async reason => {
    mocks.auth.mockRejectedValueOnce(new Error(reason));
    expect(await runMCPCommand("auth", ["figma"])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(reason);
    expect(console.log).not.toHaveBeenCalled();
  });
  it("supports an explicit argument boundary", async () => {
    expect(await runMCPCommand("auth", ["--", "figma"])).toBe(0);
  });
});
