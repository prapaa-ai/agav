/**
 * Agent loader - scans three-tier search path and loads agent definitions
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type {
  AgentDefinition,
  AgentManifest,
  AgentOrigin,
} from "./types.js";
import type { ToolDefinition } from "../tools/types.js";

/**
 * Simple YAML parser for frontmatter
 * Handles basic YAML structures needed for AGENT.md
 */
function parseSimpleYAML(yamlText: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = yamlText.split('\n');
  let currentKey: string | null = null;
  let currentArray: any[] | null = null;
  let currentObject: Record<string, any> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      if (currentArray) {
        currentArray.push(value);
      } else if (currentKey) {
        currentArray = [value];
        result[currentKey] = currentArray;
      }
      continue;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      // Check if it's a nested object key (indented lines will follow)
      if (!value) {
        currentKey = key;
        currentArray = null;
        currentObject = {};
        result[key] = currentObject;
      } else {
        currentArray = null;
        currentObject = null;
        currentKey = key;
        // Parse value
        if (value === 'true') {
          result[key] = true;
        } else if (value === 'false') {
          result[key] = false;
        } else if (/^\d+$/.test(value)) {
          result[key] = parseInt(value, 10);
        } else if (value.startsWith('[') && value.endsWith(']')) {
          // Parse bracket-style array: [item1, item2, item3]
          const arrayContent = value.slice(1, -1).trim();
          if (arrayContent) {
            result[key] = arrayContent.split(',').map((item) => item.trim().replace(/^["']|["']$/g, ''));
          } else {
            result[key] = [];
          }
        } else {
          // Remove quotes if present
          result[key] = value.replace(/^["']|["']$/g, '');
        }
      }
      continue;
    }

    // Nested key-value for objects
    if (currentObject && trimmed.includes(':')) {
      const nestedColonIndex = trimmed.indexOf(':');
      const nestedKey = trimmed.slice(0, nestedColonIndex).trim();
      const nestedValue = trimmed.slice(nestedColonIndex + 1).trim();
      if (nestedValue === 'true') {
        currentObject[nestedKey] = true;
      } else if (nestedValue === 'false') {
        currentObject[nestedKey] = false;
      } else {
        currentObject[nestedKey] = nestedValue.replace(/^["']|["']$/g, '');
      }
    }
  }

  return result;
}

/**
 * Three-tier search path for agents (later tiers override earlier by name)
 */
function getAgentSearchPaths(cwd: string): Array<{ path: string; origin: AgentOrigin }> {
  const currentFilePath = fileURLToPath(import.meta.url);
  const bundledPath = resolve(dirname(currentFilePath), "bundled");
  const globalPath = join(homedir(), ".agav", "agents");
  const projectPath = join(cwd, ".agav", "agents");

  return [
    { path: bundledPath, origin: "bundled" as AgentOrigin },
    { path: globalPath, origin: "global" as AgentOrigin },
    { path: projectPath, origin: "project" as AgentOrigin },
  ];
}

/**
 * Parse AGENT.md frontmatter and body
 */
async function parseAgentMarkdown(path: string): Promise<{ manifest: AgentManifest; systemPrompt: string }> {
  const content = await readFile(path, "utf-8");

  // Extract YAML frontmatter between --- delimiters
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid AGENT.md format: missing YAML frontmatter in ${path}`);
  }

  const [, frontmatter, body] = match;
  const manifest = parseSimpleYAML(frontmatter) as AgentManifest;

  // Validate required fields
  if (!manifest.name) {
    throw new Error(`Invalid AGENT.md: missing 'name' field in ${path}`);
  }
  if (!manifest.description) {
    throw new Error(`Invalid AGENT.md: missing 'description' field in ${path}`);
  }
  if (!manifest.version) {
    throw new Error(`Invalid AGENT.md: missing 'version' field in ${path}`);
  }

  return { manifest, systemPrompt: body.trim() };
}

/**
 * Load tools from agent's tools directory
 */
async function loadAgentTools(
  agentDir: string,
  toolsDir: string,
  toolPermissions: Record<string, "safe" | "destructive"> = {}
): Promise<ToolDefinition[]> {
  const toolsDirPath = resolve(agentDir, toolsDir);
  const tools: ToolDefinition[] = [];

  let entries: string[];
  try {
    entries = await readdir(toolsDirPath);
  } catch {
    // No tools directory
    return tools;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;

    const toolPath = join(toolsDirPath, entry);
    try {
      const mod = await import(pathToFileURL(toolPath).href);
      const toolDef = mod.default || mod;

      if (!toolDef.schema || !toolDef.execute) {
        console.warn(`Skipping invalid tool in ${toolPath}: missing schema or execute`);
        continue;
      }

      // Apply tool permission from manifest
      const permission = toolPermissions[toolDef.schema.name];
      if (permission === "safe") {
        toolDef.schema.destructive = false;
      } else if (permission === "destructive") {
        toolDef.schema.destructive = true;
      }

      tools.push(toolDef);
    } catch (error) {
      console.warn(`Failed to load tool from ${toolPath}:`, error);
    }
  }

  return tools;
}

/**
 * Load a single agent from a directory
 */
export async function loadAgent(agentDir: string, origin: AgentOrigin, alias?: string): Promise<AgentDefinition | null> {
  const manifestPath = join(agentDir, "AGENT.md");

  try {
    await stat(manifestPath);
  } catch {
    // No AGENT.md in this directory
    return null;
  }

  try {
    const { manifest, systemPrompt } = await parseAgentMarkdown(manifestPath);
    const toolsDir = manifest["tools-dir"] || "./tools";
    const tools = await loadAgentTools(agentDir, toolsDir, manifest["tool-permissions"]);

    return {
      manifest: { ...manifest, enabled: manifest.enabled ?? true },
      systemPrompt,
      tools,
      origin,
      path: agentDir,
      alias,
    };
  } catch (error) {
    console.warn(`Failed to load agent from ${agentDir}:`, error);
    return null;
  }
}

/**
 * Load all agents from the three-tier search path
 */
export async function loadAgents(cwd: string = process.cwd()): Promise<AgentDefinition[]> {
  const searchPaths = getAgentSearchPaths(cwd);
  const agentMap = new Map<string, AgentDefinition>();

  for (const { path: searchPath, origin } of searchPaths) {
    let entries: string[];
    try {
      entries = await readdir(searchPath);
    } catch {
      // Directory doesn't exist
      continue;
    }

    for (const entry of entries) {
      const agentDir = join(searchPath, entry);
      const stats = await stat(agentDir).catch(() => null);
      if (!stats?.isDirectory()) continue;

      const agent = await loadAgent(agentDir, origin);
      if (!agent) continue;

      // Later tiers override earlier tiers by name
      const key = agent.alias || agent.manifest.name;
      agentMap.set(key, agent);
    }
  }

  // Merge registry enabled state and prune stale entries
  const { loadRegistry, saveRegistry } = await import("./agent-registry.js");
  const registry = await loadRegistry();
  let registryDirty = false;

  const agents = Array.from(agentMap.values());
  for (const agent of agents) {
    const key = agent.alias || agent.manifest.name;
    const registryEntry = registry.agents[key];
    if (registryEntry) {
      // Registry enabled state overrides manifest
      agent.manifest.enabled = registryEntry.enabled;
    }
  }

  // Prune stale registry entries (registered but no loadable files on disk)
  for (const key of Object.keys(registry.agents)) {
    if (agentMap.has(key)) continue; // already found via scan — fine
    // Check if files exist at the global path for this registry key
    const { homedir } = await import("node:os");
    const globalPath = join(homedir(), ".agav", "agents", key);
    const check = await loadAgent(globalPath, "global");
    if (!check) {
      // Stale entry — files are missing or AGENT.md is gone
      delete registry.agents[key];
      registryDirty = true;
    }
  }

  if (registryDirty) {
    await saveRegistry(registry).catch(() => {}); // non-fatal
  }

  return agents;
}

/**
 * Get cached agents (singleton pattern for hot-reload support)
 */
let cachedAgents: AgentDefinition[] | null = null;

export function getCachedAgents(): AgentDefinition[] {
  return cachedAgents || [];
}

export function setCachedAgents(agents: AgentDefinition[]): void {
  cachedAgents = agents;
}

/**
 * Get a single agent by name or alias
 */
export function getAgent(nameOrAlias: string): AgentDefinition | undefined {
  return getCachedAgents().find(
    (a) => a.manifest.name === nameOrAlias || a.alias === nameOrAlias
  );
}
