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
  JSONRPCNotification,
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

  private abortController: AbortController | null = null;
  private postUrl: string | null = null;
  // Which remote transport is active once the handshake succeeds.
  private activeTransport: "http" | "sse" | null = null;
  // Session id issued by a Streamable HTTP server via the Mcp-Session-Id header.
  private sessionId: string | null = null;

  // Starts the MCP subprocess or connects to remote/SSE, completes the handshake, and caches its tools.
  async start(): Promise<void> {
    if (this.config.type === "remote" || this.config.url) {
      await this.startRemote();
    } else {
      await this.startStdio();
    }
  }

  async startRemote(): Promise<void> {
    const urlStr = this.config.url;
    if (!urlStr) {
      throw new Error(`Remote MCP server ${this.serverName} is missing 'url' config`);
    }

    this.abortController = new AbortController();

    const explicit = this.config.transport;
    if (explicit === "http") {
      await this.connectHttp(urlStr);
    } else if (explicit === "sse") {
      await this.connectSse(urlStr);
    } else {
      // Auto-detect: prefer the current Streamable HTTP transport, then fall back
      // to the legacy HTTP+SSE transport used by older servers.
      try {
        await this.connectHttp(urlStr);
      } catch (httpErr) {
        try {
          await this.connectSse(urlStr);
        } catch {
          // Surface the primary (HTTP) failure — it's the more relevant one.
          throw httpErr;
        }
      }
    }

    // Complete the MCP lifecycle now that a transport is established.
    await this.completeHandshake();
  }

  // Streamable HTTP transport: every request is a POST to the base URL. The initialize
  // response carries an Mcp-Session-Id header echoed on all subsequent requests. Responses
  // arrive either as a JSON body or an SSE-framed text/event-stream body on the same POST.
  private async connectHttp(urlStr: string): Promise<void> {
    this.activeTransport = "http";
    this.postUrl = urlStr;

    const initResult = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agav", version: "0.1.0" },
    })) as { capabilities?: MCPServerCapabilities };

    this.serverCapabilities = initResult.capabilities ?? {};
    await this.sendRemote({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  // Legacy HTTP+SSE transport: open a GET event stream, wait for the 'endpoint' event to learn
  // the POST URL, and stream all responses/notifications over the same GET connection.
  private async connectSse(urlStr: string): Promise<void> {
    this.activeTransport = "sse";
    const signal = this.abortController!.signal;

    const response = await fetch(urlStr, {
      headers: {
        ...this.config.headers,
        "Accept": "text/event-stream",
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to connect to remote MCP server ${this.serverName}: ${response.statusText}`);
    }

    // Wait for the first 'endpoint' event to get postUrl, while streaming later messages.
    const endpointPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for 'endpoint' event from remote MCP server ${this.serverName}`));
      }, 10000);

      const sseParser = this.consumeSseStream(response, signal, (eventName, data) => {
        if (eventName === "endpoint" && data) {
          clearTimeout(timeout);
          resolve(new URL(data, urlStr).toString());
          return;
        }
        this.dispatchMessage(data);
      });

      sseParser.then(() => {
        // The SSE stream closed cleanly (server sent done: true). If
        // we never received the endpoint event, reject immediately
        // instead of waiting for the 10-second timeout.
        if (!this.postUrl) {
          clearTimeout(timeout);
          reject(new Error(`SSE stream to ${this.serverName} closed before receiving endpoint event`));
          return;
        }
        // Once the stream closes, no further server→client messages
        // can arrive — any pending requests will hang forever. Reject
        // them immediately so callers get an actionable error instead
        // of a silent timeout.
        if (!signal.aborted && this.pending.size > 0) {
          const err = new Error(`SSE stream to ${this.serverName} closed unexpectedly`);
          process.stderr.write(`[mcp:${this.serverName}] SSE stream closed by server, rejecting ${this.pending.size} pending request(s)\n`);
          for (const [, p] of this.pending) {
            p.reject(err);
          }
          this.pending.clear();
        }
      }).catch((err) => {
        clearTimeout(timeout);
        if (!signal.aborted) {
          process.stderr.write(`[mcp:${this.serverName}] stream error: ${err instanceof Error ? err.message : String(err)}\n`);
          for (const [, p] of this.pending) {
            p.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.pending.clear();
        }
        reject(err);
      });
    });

    this.postUrl = await endpointPromise;

    const initResult = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agav", version: "0.1.0" },
    })) as { capabilities?: MCPServerCapabilities };

    this.serverCapabilities = initResult.capabilities ?? {};
    await this.sendRemote({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  // Shared MCP lifecycle after a transport is up: discover tools, then optional resources/prompts.
  private async completeHandshake(): Promise<void> {
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

  // Reads an SSE-framed response body, invoking onEvent for each complete event block.
  private async consumeSseStream(
    response: Response,
    signal: AbortSignal,
    onEvent: (eventName: string, data: string) => void,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";

        for (const part of parts) {
          let eventName = "message";
          let data = "";
          for (const line of part.split(/\r?\n/)) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += (data ? "\n" : "") + line.slice(5).trim();
            }
          }
          if (data) onEvent(eventName, data);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // Routes a raw JSON-RPC payload string to the matching pending request or notification handler.
  private dispatchMessage(data: string): void {
    let msg: JSONRPCMessage;
    try {
      msg = JSON.parse(data) as JSONRPCMessage;
    } catch {
      return; // Ignore parse errors
    }
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
  }

  private async sendRemote(msg: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    if (!this.postUrl) {
      throw new Error(`Remote MCP server ${this.serverName} postUrl is not initialized`);
    }

    const headers: Record<string, string> = {
      ...this.config.headers,
      "Content-Type": "application/json",
    };
    // Streamable HTTP servers stream responses back as SSE on the POST itself.
    if (this.activeTransport === "http") {
      headers["Accept"] = "application/json, text/event-stream";
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await fetch(this.postUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to send message to remote MCP server ${this.serverName}: ${response.statusText}`);
    }

    // Capture the session id issued during initialize (Streamable HTTP only).
    if (this.activeTransport === "http") {
      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    }

    // For the SSE transport, replies arrive on the standalone GET stream, so nothing to read here.
    if (this.activeTransport !== "http") return;

    // Notifications get a 202 with no body — nothing to parse.
    if (response.status === 202) return;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      // Read the SSE-framed reply for this single POST until the stream closes.
      await this.consumeSseStream(response, this.abortController!.signal, (_evt, data) => {
        this.dispatchMessage(data);
      });
    } else if (contentType.includes("application/json")) {
      const text = await response.text();
      if (text) this.dispatchMessage(text);
    } else {
      // A 2xx with no MCP-shaped body means this isn't really a Streamable HTTP endpoint.
      // Reject the in-flight request so auto-detect can fall back to SSE instead of hanging.
      throw new Error(
        `Remote MCP server ${this.serverName} returned unexpected content-type '${contentType || "none"}' for Streamable HTTP`,
      );
    }
  }

  async startStdio(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`Stdio MCP server ${this.serverName} is missing 'command' config`);
    }
    const proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
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
    if (this.config.type === "remote" || this.config.url) {
      this.abortController?.abort();
      this.abortController = null;
      this.postUrl = null;
      this.activeTransport = null;
      this.sessionId = null;
    } else {
      this.process?.kill();
      this.process = null;
    }
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

  // Writes a newline-delimited JSON-RPC message to the MCP subprocess or remote POST endpoint.
  private send(msg: JSONRPCRequest | JSONRPCNotification): void {
    if (this.config.type === "remote" || this.config.url) {
      this.sendRemote(msg).catch((err) => {
        // Fail the matching in-flight request immediately instead of waiting for the timeout.
        const id = "id" in msg ? msg.id : undefined;
        if (id != null) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        process.stderr.write(`[mcp:${this.serverName}] failed to send message: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    } else {
      if (!this.process?.stdin?.writable) {
        throw new Error(`MCP server ${this.serverName} is not running`);
      }
      this.process.stdin.write(JSON.stringify(msg) + "\n");
    }
  }
}
