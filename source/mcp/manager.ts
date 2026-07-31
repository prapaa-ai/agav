import { MCPClient } from "./client.js";
import type { MCPServerConfig, MCPTool, MCPResource, MCPPrompt, MCPResourceContent } from "./types.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";

// Coordinates multiple MCP server clients and exposes them as Agav tools.
export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private onChange: (() => void) | null = null;

  // Registers a callback invoked whenever any server's tools/resources/prompts change.
  setOnChange(handler: () => void): void {
    this.onChange = handler;
  }

  // Starts or restarts a named MCP server and returns its discovered tools.
  async startServer(name: string, config: MCPServerConfig): Promise<MCPTool[]> {
    if (this.clients.has(name)) {
      await this.stopServer(name);
    }

    const client = new MCPClient(name, config);
    client.onNotification(() => this.onChange?.());
    try {
      await client.start();
      this.clients.set(name, client);
      return client.getTools();
    } catch (err) {
      client.stop();
      throw err;
    }
  }

  async stopServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      client.stop();
      this.clients.delete(name);
    }
  }

  stopAll(): void {
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
  }

  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const client of this.clients.values()) {
      tools.push(...client.getTools());
    }
    return tools;
  }

  // Adapts live MCP tools into the local ToolDefinition shape used by the agent loop.
  getToolDefinitions(): ToolDefinition[] {
    return this.getAllTools().map((mcpTool) => ({
      schema: {
        name: mcpTool.name,
        description: `[MCP: ${mcpTool.serverName}] ${mcpTool.description}`,
        inputSchema: mcpTool.inputSchema,
      },
      execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const client = this.clients.get(mcpTool.serverName);
        if (!client) {
          return { output: `MCP server ${mcpTool.serverName} is not running`, isError: true };
        }
        try {
          const output = await client.callTool(mcpTool.name, input);
          return { output, isError: false };
        } catch (err) {
          return {
            output: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    }));
  }

  getServerNames(): string[] {
    return [...this.clients.keys()];
  }

  getAllResources(): MCPResource[] {
    const resources: MCPResource[] = [];
    for (const client of this.clients.values()) {
      resources.push(...client.getResources());
    }
    return resources;
  }

  async readResource(serverName: string, uri: string): Promise<MCPResourceContent[]> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} is not running`);
    }
    return client.readResource(uri);
  }

  // Finds which connected server owns a resource URI, without relying on the caller to know.
  findResourceServer(uri: string): string | undefined {
    return this.getAllResources().find((r) => r.uri === uri)?.serverName;
  }

  // Reads a resource by URI alone, resolving the owning server from the last-known resource list.
  async readResourceByUri(uri: string): Promise<MCPResourceContent[]> {
    const serverName = this.findResourceServer(uri);
    if (!serverName) {
      throw new Error(`No connected MCP server exposes resource ${uri}`);
    }
    return this.readResource(serverName, uri);
  }

  getAllPrompts(): MCPPrompt[] {
    const prompts: MCPPrompt[] = [];
    for (const client of this.clients.values()) {
      prompts.push(...client.getPrompts());
    }
    return prompts;
  }

  async getPrompt(serverName: string, promptName: string, args: Record<string, string>) {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} is not running`);
    }
    return client.getPrompt(promptName, args);
  }

  // Builds a short listing of discovered resources for injection into the system prompt.
  getResourceContextBlock(): string {
    const resources = this.getAllResources();
    if (resources.length === 0) return "";

    return resources
      .map((r) => `- uri: ${r.uri} — name: ${r.name}${r.description ? ` — ${r.description}` : ""}`)
      .join("\n");
  }

  // A single on-demand tool the agent can use to fetch a resource's contents by URI.
  // Takes only the URI — the server it belongs to is resolved internally, since URIs are already
  // unique across connected servers and asking the model to also track a serverName invites mixups
  // (e.g. mistaking a resource's own URI scheme for the MCP server's name).
  getResourceToolDefinition(): ToolDefinition {
    return {
      schema: {
        name: "mcp_read_resource",
        description:
          "Reads the contents of an MCP resource discovered from a connected MCP server. " +
          "Provide the uri exactly as listed in the system prompt's 'Available MCP resources' section.",
        inputSchema: {
          type: "object",
          properties: {
            uri: { type: "string", description: "URI of the resource to read" },
          },
          required: ["uri"],
        },
      },
      execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const uri = String(input.uri ?? "");
        try {
          const contents = await this.readResourceByUri(uri);
          const output = contents
            .map((c) => c.text ?? (c.blob ? `[Binary content: ${c.mimeType ?? "unknown type"}]` : ""))
            .filter(Boolean)
            .join("\n");
          return { output: output || "No output", isError: false };
        } catch (err) {
          return {
            output: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    };
  }
}
