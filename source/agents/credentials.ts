/**
 * Agent credentials management - per-agent config.json with encryption
 */

import { readFile, writeFile, mkdir, rename, rm, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { encrypt, decrypt } from "../utils/encrypt.js";
import type { AgentManifest } from "./types.js";
import type { AgavConfig } from "../config/config.js";

function collectGlobalMcpEnv(manifest: AgentManifest, globalConfig?: AgavConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (globalConfig?.mcpServers) {
    for (const { key } of manifest["mcp-servers"] ?? []) {
      const srv = globalConfig.mcpServers[key];
      if (!srv) continue;
      if (srv.env) Object.assign(env, srv.env);
    }
  }
  return env;
}

/**
 * Load agent credentials from config.json
 */
export async function loadAgentConfig(agentPath: string): Promise<Record<string, string>> {
  const configPath = join(agentPath, "config.json");
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);

    // Decrypt values
    const decrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string") {
        try {
          decrypted[key] = decrypt(value);
        } catch {
          console.warn(`[credentials] Decryption failed for "${key}" in ${configPath}, using as plaintext`);
          decrypted[key] = value;
        }
      }
    }

    return decrypted;
  } catch {
    // No config.json
    return {};
  }
}

/**
 * Save agent credentials to config.json (encrypted)
 */
export async function saveAgentConfig(
  agentPath: string,
  config: Record<string, string>
): Promise<void> {
  // Encrypt values
  const encrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    encrypted[key] = encrypt(value);
  }

  const configPath = join(agentPath, "config.json");
  await mkdir(agentPath, { recursive: true });
  const tmpPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(encrypted, null, 2), { encoding: "utf-8", mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, configPath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** Resolve credentials from declared servers and legacy per-agent config. */
export function resolveAgentMcpEnv(
  manifest: AgentManifest,
  globalConfig: AgavConfig | undefined,
  agentConfig: Record<string, string>,
): Record<string, string> {
  const env = collectGlobalMcpEnv(manifest, globalConfig);
  for (const srv of manifest["mcp-servers"] ?? []) {
    const prefix = `mcp:${srv.key}:`;
    for (const [key, value] of Object.entries(agentConfig)) {
      if (key.startsWith(prefix) && key.length > prefix.length) env[key.slice(prefix.length)] = value;
    }
  }
  for (const key of manifest["required-config"] ?? []) {
    if (agentConfig[key] && !env[key]) env[key] = agentConfig[key];
    if (!env[key] && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/**
 * Check if agent has all required credentials.
 * Resolution: global/project config mcpServers env → process.env
 */
export async function hasRequiredCredentials(
  agentPath: string,
  manifest: AgentManifest,
  globalConfig?: AgavConfig
): Promise<boolean> {
  return (await getMissingCredentials(agentPath, manifest, globalConfig)).length === 0;
}

/**
 * Get missing credential keys.
 * Resolution: global/project config mcpServers env → process.env
 */
export async function getMissingCredentials(
  agentPath: string,
  manifest: AgentManifest,
  globalConfig?: AgavConfig
): Promise<string[]> {
  const requiredConfig = manifest["required-config"] || [];
  if (requiredConfig.length === 0) return [];

  const mcpEnv = resolveAgentMcpEnv(manifest, globalConfig, await loadAgentConfig(agentPath));
  return requiredConfig.filter((key) => !mcpEnv[key] && !process.env[key]);
}

/**
 * Prompt user for credentials (to be called from TUI)
 * Returns the credentials that should be saved
 */
export function buildCredentialPrompts(
  manifest: AgentManifest,
  existingConfig: Record<string, string> = {}
): Array<{ key: string; label: string; defaultValue?: string }> {
  const requiredConfig = manifest["required-config"] || [];
  return requiredConfig.map((key) => ({
    key,
    label: key,
    defaultValue: existingConfig[key],
  }));
}
