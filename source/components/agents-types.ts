import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../agents/types.js";

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
  type?: "native-tools";
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

export function getConfigItems(agent: AgentDefinition): ConfigItem[] {
  const credItems: ConfigItem[] = (agent.manifest["required-config"] ?? []).map((k) => ({
    key: k,
    label: k,
    secret: true,
  }));
  return [
    ...credItems,
    { key: "model",  label: "Model  (blank = inherit session)", secret: false },
    { key: "effort", label: "Effort (blank = inherit session)", secret: false },
    ...(agent.origin !== "bundled" && agent.manifest.type !== "a2a"
      ? [{ key: "native-tools", label: "Native Tools", secret: false, type: "native-tools" as const }]
      : []),
  ];
}

export function parseFileUrl(url: string): string {
  let path = url.replace(/^file:\/\//, "");
  if (path.match(/^\/[A-Za-z]:/)) path = path.substring(1);
  return path;
}
