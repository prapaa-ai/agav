/**
 * MCP Registry search — discovers MCP servers from registry.modelcontextprotocol.io
 */

import type { MCPEnvVarDeclaration } from "./types.js";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

export interface MCPRegistryRemote {
  type: string;
  url: string;
}

export interface MCPRegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string };
  packageArguments?: Array<{ value: string; type: string }>;
  environmentVariables?: MCPEnvVarDeclaration[];
}

export interface MCPRegistryServer {
  name: string;
  description: string;
  title?: string;
  version?: string;
  remotes?: MCPRegistryRemote[];
  packages?: MCPRegistryPackage[];
  repository?: {
    url: string;
    source?: string;
  };
}

export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface RegistryResponse {
  servers: Array<{ server: MCPRegistryServer }>;
  metadata?: { nextCursor?: string; count?: number };
}

export async function searchMCPRegistry(
  query: string,
  opts?: { limit?: number; cursor?: string },
): Promise<{ servers: MCPRegistryServer[]; nextCursor: string | null }> {
  const limit = opts?.limit ?? 20;
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
  });
  if (opts?.cursor) params.set("cursor", opts.cursor);

  const url = `${REGISTRY_BASE}/v0/servers?${params}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`MCP registry search failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as RegistryResponse;
  const servers = (data.servers ?? []).map((item) => item.server).filter(Boolean);
  return {
    servers,
    nextCursor: data.metadata?.nextCursor ?? null,
  };
}

export async function discoverMCPTools(
  agentName: string,
  _agentDescription: string,
): Promise<MCPRegistryServer[]> {
  const seen = new Map<string, MCPRegistryServer>();
  const nameLower = agentName.toLowerCase().trim();
  if (!nameLower) return [];

  const searches = [nameLower].map(async (term) => {
    try {
      const { servers, nextCursor } = await searchMCPRegistry(term, { limit: 20 });
      for (const s of servers) {
        if (!seen.has(s.name)) seen.set(s.name, s);
      }
      if (nextCursor && seen.size < 50) {
        const page2 = await searchMCPRegistry(term, { limit: 20, cursor: nextCursor });
        for (const s of page2.servers) {
          if (!seen.has(s.name)) seen.set(s.name, s);
        }
      }
    } catch {
      // Individual search failures are non-fatal
    }
  });

  await Promise.allSettled(searches);

  const results = [...seen.values()];
  results.sort((a, b) => {
    const aMatch = a.name.toLowerCase().includes(nameLower) ? 1 : 0;
    const bMatch = b.name.toLowerCase().includes(nameLower) ? 1 : 0;
    return bMatch - aMatch;
  });
  return results.slice(0, 50);
}

/**
 * Connect to an MCP server's HTTP endpoint and discover its tools via the
 * standard MCP handshake (initialize → notifications/initialized → tools/list).
 */
export async function fetchServerTools(server: MCPRegistryServer): Promise<MCPToolInfo[]> {
  const remote = server.remotes?.find(
    (r) => r.type === "streamable-http" || r.type === "sse",
  );
  if (!remote) return [];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  const initRes = await fetch(remote.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agav", version: "1.0.0" },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!initRes.ok) throw new Error(`Initialize failed: ${initRes.status}`);

  const sessionId = initRes.headers.get("mcp-session-id");
  if (sessionId) headers["mcp-session-id"] = sessionId;

  await parseJsonRpcResponse(initRes);

  await fetch(remote.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(5_000),
  });

  const toolsRes = await fetch(remote.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!toolsRes.ok) throw new Error(`tools/list failed: ${toolsRes.status}`);

  const toolsData = (await parseJsonRpcResponse(toolsRes)) as { tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }> };
  const tools = toolsData?.tools ?? [];
  return tools.map((t) => ({
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    inputSchema: t.inputSchema,
  }));
}

async function parseJsonRpcResponse(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.result !== undefined) return parsed.result;
        } catch { /* skip non-JSON lines */ }
      }
    }
    return null;
  }
  const json = (await res.json()) as { result?: unknown };
  return json.result ?? json;
}

export function serverToMCPConfig(
  server: MCPRegistryServer,
): { key: string; command: string; args?: string[] } | null {
  if (!server.remotes?.length) return null;
  const httpRemote = server.remotes.find(
    (r) => r.type === "streamable-http" || r.type === "sse",
  );
  if (httpRemote) {
    return {
      key: serverKey(server.name),
      command: "npx",
      args: ["-y", "mcp-remote", httpRemote.url],
    };
  }
  return null;
}

export function extractRequiredEnvVars(server: MCPRegistryServer): MCPEnvVarDeclaration[] {
  const pkg = server.packages?.[0];
  if (!pkg?.environmentVariables?.length) return [];
  return pkg.environmentVariables.map((ev) => ({
    name: ev.name,
    description: ev.description,
    isRequired: ev.isRequired ?? true,
    isSecret: ev.isSecret ?? false,
  }));
}

function serverKey(name: string): string {
  const last = name.split("/").pop() || name;
  return last.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}
