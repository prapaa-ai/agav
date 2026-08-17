/**
 * Agent credentials management - per-agent config.json with encryption
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encrypt, decrypt } from "../utils/encrypt.js";
import type { AgentManifest } from "./types.js";

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
          // Not encrypted, use as-is
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
  await writeFile(configPath, JSON.stringify(encrypted, null, 2), "utf-8");
}

/**
 * Check if agent has all required credentials
 */
export async function hasRequiredCredentials(
  agentPath: string,
  manifest: AgentManifest
): Promise<boolean> {
  const requiredConfig = manifest["required-config"] || [];
  if (requiredConfig.length === 0) return true;

  const config = await loadAgentConfig(agentPath);
  return requiredConfig.every((key) => key in config && config[key]);
}

/**
 * Get missing credential keys - checks config.json first, then process.env
 */
export async function getMissingCredentials(
  agentPath: string,
  manifest: AgentManifest
): Promise<string[]> {
  const requiredConfig = manifest["required-config"] || [];
  if (requiredConfig.length === 0) return [];

  const config = await loadAgentConfig(agentPath);
  return requiredConfig.filter((key) => {
    const fromFile = config[key];
    const fromEnv = process.env[key];
    return !fromFile && !fromEnv;
  });
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
