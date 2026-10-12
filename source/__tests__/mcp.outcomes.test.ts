import { describe, expect, it, vi } from "vitest";
import { mcpCommand } from "../commands/mcp.js";
import type { CommandContext } from "../commands/types.js";

function context(auth: () => Promise<void>, pending: string[] = []) {
  return { authenticateMCPServer: auth, getMCPAuthenticationRequired: () => pending, showStatus: vi.fn() } as unknown as CommandContext;
}
describe("MCP OAuth outcome feedback", () => {
  it("logs out by name and reports remaining authentication without revocation claims", async () => {
    const ctx = context(async () => {}, ["linear"]);
    ctx.logoutMCPServer = vi.fn(async () => {});
    expect(await mcpCommand.execute("logout linear", ctx)).toEqual({ type: "message", text: 'Logged out of MCP server "linear" and removed cached OAuth credentials. 1 MCP server requires authentication. Provider authorization grants are not revoked.' });
    expect(ctx.logoutMCPServer).toHaveBeenCalledExactlyOnceWith("linear");
  });
  it("reports logout failure without a false success", async () => {
    const ctx = context(async () => {});
    ctx.logoutMCPServer = async () => { throw new Error("permission denied"); };
    expect(await mcpCommand.execute("logout linear", ctx)).toEqual({ type: "message", text: 'MCP logout failed for "linear": permission denied' });
  });
  it.each([0, 1, 4])("names the connected server and reports %i remaining authentications", async count => {
    const pending = Array.from({ length: count }, (_, i) => `server-${i}`);
    expect(await mcpCommand.execute("auth linear", context(async () => {}, pending))).toEqual({ type: "message", text: `Authenticated and connected MCP server "linear".${count > 0 ? ` ${count} MCP server${count === 1 ? " still requires" : "s still require"} authentication.` : ""}` });
  });
  it.each(["denied", "cancelled", "timed out", "Cannot open the browser"])("does not report success on %s", async reason => {
    const result = await mcpCommand.execute("auth linear", context(async () => { throw new Error(reason); }, ["linear"]));
    expect(result).toEqual({ type: "message", text: `MCP sign-in failed for "linear": ${reason}` });
  });
});
