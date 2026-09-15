import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";
import type { AgavConfig } from "../config/config.js";
import { getRequiredEnvVars } from "../mcp/env-vars.js";

export type Tab = "list" | "marketplace" | "create";

export type ListView = "list" | "inspect" | "config";

export interface AgentsTUIProps {
  onExit: () => void;
  provider?: import("../providers/types.js").LLMProvider | null;
  config?: import("../config/config.js").AgavConfig;
}

export type AgentReadiness = { ready: boolean; missing: string[] };
export type ReadinessMap = Record<string, AgentReadiness>;

export interface ConfigItem {
  key: string;
  label: string;
  secret: boolean;
  mcpServerKey?: string;
  envVarKey?: string;
}

export const EFFORT_VALUES = ["low", "medium", "high", "max"] as const;

export function resolveConfigDir(agent: AgentDefinition): string {
  if (agent.origin === "bundled") {
    return join(homedir(), ".agav", "agents", agent.manifest.name);
  }
  return agent.path;
}

export function resolveConfigPath(agent: AgentDefinition): string {
  return join(resolveConfigDir(agent), "config.json");
}

export function getConfigItems(
  agent: AgentDefinition,
  config?: AgavConfig,
): ConfigItem[] {
  const items: ConfigItem[] = [
    { key: "model",  label: "Model  (blank = inherit session)", secret: false },
    { key: "effort", label: "Effort (blank = inherit session)", secret: false },
  ];

  const mcpServers = agent.manifest["mcp-servers"] ?? [];
  for (const srv of mcpServers) {
    const serverConfig = config?.mcpServers?.[srv.key];
    if (!serverConfig) continue;
    const vars = getRequiredEnvVars(srv.key, serverConfig);
    for (const v of vars) {
      items.push({
        key: `mcp:${srv.key}:${v.name}`,
        label: `${srv.key} → ${v.name}`,
        secret: true,
        mcpServerKey: srv.key,
        envVarKey: v.name,
      });
    }
  }

  return items;
}

export function parseFileUrl(url: string): string {
  let path = url.replace(/^file:\/\//, "");
  if (path.match(/^\/[A-Za-z]:/)) path = path.substring(1);
  return path;
}
