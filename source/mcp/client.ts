import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  MCPServerConfig,
  MCPTool,
  MCPResource,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptMessage,
  MCPServerCapabilities,
  JSONRPCRequest,
  JSONRPCMessage,
} from "./types.js";

// Lightweight JSON-RPC client for a single MCP server subprocess.
export class MCPClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  // Tracks in-flight requests so stdout responses can resolve the right promise.
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private tools: MCPTool[] = [];
  private resources: MCPResource[] = [];
  private prompts: MCPPrompt[] = [];
  private serverCapabilities: MCPServerCapabilities = {};
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  readonly serverName: string;
  private config: MCPServerConfig;

  constructor(name: string, config: MCPServerConfig) {
    this.serverName = name;
    this.config = config;
  }

  // Registers a callback invoked whenever the server sends a notification.
  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  // Starts the MCP subprocess, completes the handshake, and caches its tools.
  async start(): Promise<void> {
    const proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
      shell: process.platform === "win32",
    });

    this.process = proc;

    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[mcp:${this.serverName}] ${chunk}`);
    });

    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as JSONRPCMessage;
        if ("id" in msg && msg.id != null) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if ("method" in msg && msg.method) {
          this.handleNotification(msg.method, msg.params);
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    proc.on("error", (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    proc.on("exit", (code, signal) => {
      process.stderr.write(
        `[mcp:${this.serverName}] process exited (code=${code ?? "null"}, signal=${signal ?? "null"})\n`,
      );
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP server ${this.serverName} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      }
      this.pending.clear();
      this.process = null;
    });

    // Initialize
    const initResult = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agav", version: "0.1.0" },
    })) as { capabilities?: MCPServerCapabilities };

    this.serverCapabilities = initResult.capabilities ?? {};

    // Notify the server that initialization has completed before asking for tools.
    this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} } as any);

    // Discover tools
    this.tools = await this.fetchTools();

    if (this.serverCapabilities.resources) {
      try {
        this.resources = await this.fetchResources();
      } catch {
        // Server advertised resources but the call failed — non-fatal
      }
    }

    if (this.serverCapabilities.prompts) {
      try {
        this.prompts = await this.fetchPrompts();
      } catch {
        // Server advertised prompts but the call failed — non-fatal
      }
    }
  }

  private async fetchTools(): Promise<MCPTool[]> {
    const result = (await this.request("tools/list", {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };

    return (result.tools ?? []).map((t) => ({
      name: `${this.serverName}__${t.name}`,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      serverName: this.serverName,
    }));
  }

  private async fetchResources(): Promise<MCPResource[]> {
    const result = (await this.request("resources/list", {})) as {
      resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
    };

    return (result.resources ?? []).map((r) => ({
      uri: r.uri,
      name: r.name ?? r.uri,
      description: r.description,
      mimeType: r.mimeType,
      serverName: this.serverName,
    }));
  }

  private async fetchPrompts(): Promise<MCPPrompt[]> {
    const result = (await this.request("prompts/list", {})) as {
      prompts?: Array<{
        name: string;
        description?: string;
        arguments?: Array<{ name: string; description?: string; required?: boolean }>;
      }>;
    };

    return (result.prompts ?? []).map((p) => ({
      name: `${this.serverName}__${p.name}`,
      description: p.description,
      arguments: p.arguments,
      serverName: this.serverName,
    }));
  }

  // Dispatches an incoming notification, refreshing cached lists on *_changed events.
  private handleNotification(method: string, params: unknown): void {
    (async () => {
      try {
        if (method === "notifications/tools/list_changed") {
          this.tools = await this.fetchTools();
        } else if (method === "notifications/resources/list_changed") {
          this.resources = await this.fetchResources();
        } else if (method === "notifications/prompts/list_changed") {
          this.prompts = await this.fetchPrompts();
        }
      } catch {
        // Refresh failed — keep the previous cache
      }
      this.notificationHandler?.(method, params);
    })();
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  getResources(): MCPResource[] {
    return this.resources;
  }

  getPrompts(): MCPPrompt[] {
    return this.prompts;
  }

  // Reads a resource's contents by URI.
  async readResource(uri: string): Promise<MCPResourceContent[]> {
    const result = (await this.request("resources/read", { uri })) as {
      contents?: MCPResourceContent[];
    };
    return result.contents ?? [];
  }

  // Renders a prompt template with the given arguments.
  async getPrompt(
    promptName: string,
    args: Record<string, string>,
  ): Promise<{ description?: string; messages: MCPPromptMessage[] }> {
    const actualName = promptName.startsWith(`${this.serverName}__`)
      ? promptName.slice(this.serverName.length + 2)
      : promptName;

    const result = (await this.request("prompts/get", {
      name: actualName,
      arguments: args,
    })) as { description?: string; messages?: MCPPromptMessage[] };

    return { description: result.description, messages: result.messages ?? [] };
  }

  // Calls a discovered MCP tool and flattens its content blocks into a single string.
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Strip server prefix
    const actualName = toolName.startsWith(`${this.serverName}__`)
      ? toolName.slice(this.serverName.length + 2)
      : toolName;

    const result = (await this.request("tools/call", {
      name: actualName,
      arguments: args,
    })) as {
      content?: Array<{
        type: string;
        text?: string;
        mimeType?: string;
        uri?: string;
        resource?: { uri: string; text?: string; mimeType?: string };
      }>;
    };

    return (
      result.content?.map((c) => this.renderContentBlock(c)).join("\n") ?? "No output"
    );
  }

  // Renders one MCP content block as text, so no content type is silently dropped.
  private renderContentBlock(c: {
    type: string;
    text?: string;
    mimeType?: string;
    uri?: string;
    resource?: { uri: string; text?: string; mimeType?: string };
  }): string {
    switch (c.type) {
      case "text":
        return c.text ?? "";
      case "image":
        return `[Image content omitted: ${c.mimeType ?? "unknown type"}]`;
      case "resource":
        return c.resource?.text
          ? `[Resource: ${c.resource.uri}]\n${c.resource.text}`
          : `[Resource: ${c.resource?.uri ?? "unknown"}]`;
      case "resource_link":
        return `[Resource link: ${c.uri ?? "unknown"}]`;
      default:
        return `[Unsupported content type: ${c.type}]`;
    }
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
  }

  // Sends a JSON-RPC request and resolves when the matching response arrives.
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, 30000);
    });
  }

  // Writes a newline-delimited JSON-RPC message to the MCP subprocess.
  private send(msg: JSONRPCRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error(`MCP server ${this.serverName} is not running`);
    }
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }
}
