// Launch configuration for an MCP server process.
export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "stdio" | "remote";
  url?: string;
  // Remote transport selection. "http" = Streamable HTTP (POST /mcp, current spec);
  // "sse" = legacy HTTP+SSE (GET stream + 'endpoint' event). Omitted = auto-detect
  // (try Streamable HTTP first, fall back to SSE).
  transport?: "http" | "sse";
  // Extra headers sent with every remote request (e.g. Authorization).
  headers?: Record<string, string>;
}

// Tool metadata normalized from an MCP server's tools/list response.
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

// Capabilities a server declares in its initialize response.
export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

// Resource metadata normalized from an MCP server's resources/list response.
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

// One content item from a resources/read response.
export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// Argument metadata for an MCP prompt template.
export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

// Prompt template metadata normalized from an MCP server's prompts/list response.
export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
  serverName: string;
}

// One rendered message from a prompts/get response.
export interface MCPPromptMessage {
  role: "user" | "assistant";
  content: { type: string; text?: string };
}

// Minimal JSON-RPC request shape used for MCP calls.
export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

// Minimal JSON-RPC response shape used to resolve pending MCP requests.
export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// One-way JSON-RPC notification sent or received without expecting a response.
export interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// Union of the raw shapes that can arrive on an MCP server's stdout.
export type JSONRPCMessage = JSONRPCResponse | JSONRPCNotification;
