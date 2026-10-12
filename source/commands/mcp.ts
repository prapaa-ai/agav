import type { SlashCommand } from "./types.js";

export const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "View MCP connections and sign in or out of a server",
  usage: "Usage: /mcp [auth <name> | logout <name>]\n\nBrowser sign-in only starts when you run /mcp auth <name>.",
  async execute(args, context) {
    const input = args.trim();
    if (!input || input === "list") {
      const connected = context.getDebugState().mcpServers;
      const pending = context.getMCPAuthenticationRequired?.() ?? [];
      return { type: "message", text: [
        `Connected MCP servers: ${connected.length ? connected.join(", ") : "none"}`,
        `Authentication required: ${pending.length ? pending.join(", ") : "none"}`,
        "Run /mcp auth <name> to sign in. Only this explicit action opens your browser.",
      ].join("\n") };
    }
    const logout = /^logout\s+(.+)$/.exec(input);
    if (logout && context.logoutMCPServer) {
      const name = logout[1]!;
      try {
        await context.logoutMCPServer(name);
        const remaining = context.getMCPAuthenticationRequired?.().length ?? 0;
        return { type: "message", text: `Logged out of MCP server "${name}" and removed cached OAuth credentials. ${remaining} MCP server${remaining === 1 ? " requires" : "s require"} authentication. Provider authorization grants are not revoked.` };
      } catch (error) {
        return { type: "message", text: `MCP logout failed for "${name}": ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const match = /^auth\s+(.+)$/.exec(input);
    if (!match || !context.authenticateMCPServer) return { type: "message", text: "Usage: /mcp [auth <name> | logout <name>]" };
    const name = match[1]!;
    context.showStatus(`Signing in to MCP server "${name}"...`);
    try {
      await context.authenticateMCPServer(name);
      const remaining = context.getMCPAuthenticationRequired?.().length ?? 0;
      const pending = remaining > 0 ? ` ${remaining} MCP server${remaining === 1 ? " still requires" : "s still require"} authentication.` : "";
      return { type: "message", text: `Authenticated and connected MCP server "${name}".${pending}` };
    } catch (error) {
      return { type: "message", text: `MCP sign-in failed for "${name}": ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};
