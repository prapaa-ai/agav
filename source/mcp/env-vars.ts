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
): EnvVarStatus[] {
  const declarations = getRequiredEnvVars(serverKey, serverConfig);
  const serverEnv = mergedConfig.mcpServers?.[serverKey]?.env ?? {};

  return declarations.map((decl) => {
    if (serverEnv[decl.name]) {
      return {
        name: decl.name,
        source: "global-config" as const,
        hasValue: true,
        description: decl.description,
        isSecret: decl.isSecret,
      };
    }
    if (process.env[decl.name]) {
      return {
        name: decl.name,
        source: "process-env" as const,
        hasValue: true,
        description: decl.description,
        isSecret: decl.isSecret,
      };
    }
    return {
      name: decl.name,
      source: "missing" as const,
      hasValue: false,
      description: decl.description,
      isSecret: decl.isSecret,
    };
  });
}
