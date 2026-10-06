import type { MCPServerConfig, MCPEnvVarDeclaration } from "./types.js";
import type { AgavConfig } from "../config/config.js";

export interface EnvVarStatus {
  name: string;
  source: "global-config" | "project-config" | "process-env" | "missing";
  hasValue: boolean;
  description?: string;
  isSecret?: boolean;
}

export function getRequiredEnvVars(
  _serverKey: string,
  serverConfig: MCPServerConfig,
): MCPEnvVarDeclaration[] {
  if (serverConfig.requiredEnvVars?.length) {
    return serverConfig.requiredEnvVars;
  }
  if (serverConfig.env) {
    return Object.keys(serverConfig.env).map((name) => ({
      name,
      isRequired: true,
      isSecret: true,
    }));
  }
  return [];
}

export function resolveEnvVarStatuses(
  serverKey: string,
  serverConfig: MCPServerConfig,
  mergedConfig: AgavConfig,
  rawProjectConfig?: Partial<AgavConfig>,
): EnvVarStatus[] {
  const declarations = getRequiredEnvVars(serverKey, serverConfig);
  // Project config wins in the merge, so check it first to assign correct source.
  const projectEnv = rawProjectConfig?.mcpServers?.[serverKey]?.env;
  const mergedEnv  = mergedConfig.mcpServers?.[serverKey]?.env ?? {};

  return declarations.map((decl) => {
    const base = { name: decl.name, description: decl.description, isSecret: decl.isSecret };
    if (projectEnv?.[decl.name]) return { ...base, source: "project-config" as const, hasValue: true };
    if (mergedEnv[decl.name])    return { ...base, source: "global-config"   as const, hasValue: true };
    if (process.env[decl.name])  return { ...base, source: "process-env"     as const, hasValue: true };
    return                              { ...base, source: "missing"          as const, hasValue: false };
  });
}
