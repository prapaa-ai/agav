import { loadConfig } from "../config/config.js";
import { MCPOAuth } from "../mcp/oauth.js";

/** Authenticate a configured remote server without starting an agent session. */
export async function runMCPCommand(command: string | undefined, args: string[]): Promise<number> {
  const usage = "Usage: agav mcp auth <name> | agav mcp logout <name>";
  if (!command) { console.log(usage); return 0; }
  if (command !== "auth" && command !== "logout") { console.error(usage); return 1; }
  if (args[0] === "--") args = args.slice(1);
  if (args.length !== 1 || !args[0]) { console.error(usage); return 1; }
  const name = args[0];
  const config = await loadConfig();
  const server = Object.hasOwn(config.mcpServers ?? {}, name) ? config.mcpServers![name] : undefined;
  if (!server || typeof server !== "object" || !server.url) {
    console.error(`MCP server "${name}" is not a configured remote server.`);
    return 1;
  }
  const oauth = new MCPOAuth(name, server);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("MCP OAuth login cancelled."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (command === "logout") {
      await oauth.disconnect();
      console.log(`Removed OAuth credentials for "${name}". Restart running Agav sessions to apply.`);
    } else {
      await oauth.auth(controller.signal);
      console.log(`Authenticated MCP server "${name}". Restart Agav to connect.`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
