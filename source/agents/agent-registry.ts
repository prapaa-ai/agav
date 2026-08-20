/**
 * Agent registry - manages ~/.agav/agents/registry.json
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AgentRegistry, AgentRegistryEntry } from "./types.js";

const REGISTRY_PATH = join(homedir(), ".agav", "agents", "registry.json");

// In-process mutex only — does not protect against concurrent CLI processes.
// The atomic temp-file-then-rename in saveRegistry prevents file corruption,
// but two processes can still race on read-modify-write (last writer wins).
let registryLockQueue: Promise<void> = Promise.resolve();
function acquireRegistryLock(): Promise<() => void> {
  let release!: () => void;
  const prev = registryLockQueue;
  registryLockQueue = new Promise<void>((resolve) => { release = resolve; });
  return prev.then(() => release);
}

/**
 * Load agent registry
 */
export async function loadRegistry(): Promise<AgentRegistry> {
  try {
    const content = await readFile(REGISTRY_PATH, "utf-8");
    try {
      return JSON.parse(content);
    } catch (parseErr) {
      console.warn(`[agent-registry] Failed to parse ${REGISTRY_PATH}, starting fresh:`, parseErr);
      return { agents: {} };
    }
  } catch {
    return { agents: {} };
  }
}

/**
 * Save agent registry
 */
export async function saveRegistry(registry: AgentRegistry): Promise<void> {
  await mkdir(join(homedir(), ".agav", "agents"), { recursive: true });
  const tmpPath = REGISTRY_PATH + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
  await rename(tmpPath, REGISTRY_PATH);
}

/**
 * Add or update an agent in the registry
 */
export async function registerAgent(entry: AgentRegistryEntry): Promise<void> {
  const release = await acquireRegistryLock();
  try {
    const registry = await loadRegistry();
    const key = entry.alias || entry.name;
    registry.agents[key] = entry;
    await saveRegistry(registry);
  } finally {
    release();
  }
}

/**
 * Remove an agent from the registry
 */
export async function unregisterAgent(nameOrAlias: string): Promise<void> {
  const release = await acquireRegistryLock();
  try {
    const registry = await loadRegistry();
    delete registry.agents[nameOrAlias];
    await saveRegistry(registry);
  } finally {
    release();
  }
}

/**
 * Check if an agent name or alias is already registered
 */
export async function isAgentRegistered(nameOrAlias: string): Promise<boolean> {
  const registry = await loadRegistry();
  return nameOrAlias in registry.agents;
}

/**
 * Get an agent registry entry
 */
export async function getRegistryEntry(nameOrAlias: string): Promise<AgentRegistryEntry | undefined> {
  const registry = await loadRegistry();
  return registry.agents[nameOrAlias];
}

/**
 * Update agent enabled status
 */
export async function setAgentEnabled(nameOrAlias: string, enabled: boolean): Promise<void> {
  const release = await acquireRegistryLock();
  try {
    const registry = await loadRegistry();
    let entry = registry.agents[nameOrAlias];

    if (!entry) {
      entry = {
        name: nameOrAlias,
        enabled,
        installedAt: new Date().toISOString(),
        version: "unknown",
      };
      registry.agents[nameOrAlias] = entry;
    } else {
      entry.enabled = enabled;
    }

    await saveRegistry(registry);
  } finally {
    release();
  }
}
