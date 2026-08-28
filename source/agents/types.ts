/**
 * Agent system types
 */

import type { ToolDefinition } from "../tools/types.js";
import type { EffortLevel } from "../config/config.js";

/**
 * Agent type - native (JS/TS in-process) or A2A (external process via HTTP)
 */
export type AgentType = "native" | "a2a";

/**
 * Agent origin - where the agent was loaded from
 */
export type AgentOrigin = "bundled" | "global" | "project";

/**
 * Tool permission declaration - marks tools as safe or destructive
 */
export type ToolPermission = "safe" | "destructive";

/**
 * Agent manifest - parsed from AGENT.md frontmatter
 */
export interface AgentManifest {
  name: string;
  description: string;
  version: string;
  type?: AgentType; // defaults to "native"
  author?: string;

  // Configuration
  "required-config"?: string[]; // env var names required for this agent
  "tools-dir"?: string; // path to tools directory, relative to AGENT.md
  model?: string; // optional model override
  effort?: EffortLevel; // optional effort override
  tags?: string[];
  prerequisites?: string[];
  enabled?: boolean; // defaults to true

  // Tool schemas declared in the manifest (avoids importing tool modules for schema)
  tools?: Array<{
    name: string;
    description: string;
    destructive?: boolean;
    inputSchema: Record<string, unknown>;
  }>;

  // Tool permissions
  "tool-permissions"?: Record<string, ToolPermission>;

  // Per-agent MCP servers (started when this agent runs, scoped to this agent)
  "mcp-servers"?: Array<{
    key: string;     // identifier for this MCP connection
    command: string; // "npx" | "uvx" | "docker" | "http"
    args?: string[]; // e.g. ["-y", "@scope/pkg"] or ["https://endpoint"]
    env?: Record<string, string>; // environment variables for this server
  }>;

  // A2A-specific fields
  "start-command"?: string; // command to start the A2A agent process
  endpoint?: string; // A2A endpoint URL
}

/**
 * Agent definition - manifest + loaded tools + metadata
 */
export interface AgentDefinition {
  manifest: AgentManifest;
  systemPrompt: string; // body of AGENT.md after frontmatter
  tools: ToolDefinition[]; // loaded tool definitions
  origin: AgentOrigin; // where this agent was loaded from
  path: string; // absolute path to agent directory
  alias?: string; // alias if there was a name conflict
}

/**
 * Agent registry entry - stored in ~/.agav/agents/registry.json
 */
export interface AgentRegistryEntry {
  name: string;
  alias?: string; // user-provided alias to resolve name conflicts
  enabled: boolean;
  sourceUrl?: string; // git URL if installed from marketplace
  installedAt: string; // ISO timestamp
  version: string;
}

/**
 * Agent registry file format
 */
export interface AgentRegistry {
  agents: Record<string, AgentRegistryEntry>; // keyed by name or alias
}

/**
 * Marketplace agent metadata - from index.json
 */
export interface MarketplaceAgent {
  name: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  path: string; // relative path in marketplace repo
  files?: string[]; // file list for HTTP download (relative to path)
  "tool-count": number;
  "has-destructive-tools": boolean;
}

/**
 * Marketplace category
 */
export interface MarketplaceCategory {
  id: string;
  name: string;
}

/**
 * Marketplace index.json format
 */
export interface MarketplaceIndex {
  version: string;
  agents: MarketplaceAgent[];
  categories: MarketplaceCategory[];
}
