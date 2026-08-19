/**
 * Agent loader - scans three-tier search path and loads agent definitions
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYAML } from "yaml";
import type {
  AgentDefinition,
  AgentManifest,
  AgentOrigin,
} from "./types.js";
import type { ToolDefinition } from "../tools/types.js";

/**
 * Three-tier search path for agents (later tiers override earlier by name)
 */
function getAgentSearchPaths(cwd: string): Array<{ path: string; origin: AgentOrigin }> {
  // NOTE: import.meta.url resolves inside /$bunfs under bun build --compile. See #69.
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

  // Extract YAML frontmatter between --- delimiters (handle both LF and CRLF)
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid AGENT.md format: missing YAML frontmatter in ${path}`);
  }

  const [, frontmatter, body] = match;
  const manifest = parseYAML(frontmatter) as AgentManifest;

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
 * Scan tools directory and return lazy ToolDefinitions that defer import() to first invocation.
 * This prevents third-party tool code from running at scan time.
 */
async function scanAgentTools(
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
    return tools;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;

    const toolPath = join(toolsDirPath, entry);
    const toolName = entry.replace(/\.(mjs|js)$/, "").replace(/-/g, "_");

    // Try to read schema from a companion .schema.json sidecar
    let schema: ToolDefinition["schema"];
    const sidecarPath = toolPath.replace(/\.(mjs|js)$/, ".schema.json");
    try {
      const sidecar = await readFile(sidecarPath, "utf-8");
      schema = JSON.parse(sidecar);
    } catch {
      // No sidecar — use a placeholder schema derived from the filename
      schema = {
        name: toolName,
        description: `Tool from ${agentDir}`,
        inputSchema: {
          type: "object" as const,
          properties: { task: { type: "string", description: "The task input" } },
          required: ["task"],
        },
      };
    }

    // Apply tool permission from manifest
    const permission = toolPermissions[schema.name];
    if (permission === "safe") {
      schema.destructive = false;
    } else if (permission === "destructive") {
      schema.destructive = true;
    }

    // Lazy-load the actual module on first execute() call
    let loadedExecute: ((input: Record<string, unknown>) => Promise<any>) | null = null;

    tools.push({
      schema,
      async execute(input) {
        if (!loadedExecute) {
          const mod = await import(pathToFileURL(toolPath).href);
          const toolDef = mod.default || mod;
          if (!toolDef.execute) {
            return { output: `Tool ${schema.name} has no execute function`, isError: true };
          }
          // Update schema with the real one from the module if available
          if (toolDef.schema) {
            Object.assign(schema, toolDef.schema);
            // Re-apply permission override
            if (permission === "safe") schema.destructive = false;
            else if (permission === "destructive") schema.destructive = true;
          }
          loadedExecute = toolDef.execute;
        }
        return loadedExecute!(input);
      },
    });
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
    const tools = await scanAgentTools(agentDir, toolsDir, manifest["tool-permissions"]);

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

  // Load registry first so we can skip disabled agents before importing their tools
  const { loadRegistry, saveRegistry } = await import("./agent-registry.js");
  const registry = await loadRegistry();

  for (const { path: searchPath, origin } of searchPaths) {
    let entries: string[];
    try {
      entries = await readdir(searchPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const agentDir = join(searchPath, entry);
      const stats = await stat(agentDir).catch(() => null);
      if (!stats?.isDirectory()) continue;

      // Skip agents that are explicitly disabled in the registry
      const registryEntry = registry.agents[entry];
      if (registryEntry && registryEntry.enabled === false) continue;

      const agent = await loadAgent(agentDir, origin);
      if (!agent) continue;

      // If directory name differs from manifest name, treat it as an alias
      if (entry !== agent.manifest.name && !agent.alias) {
        agent.alias = entry;
      }

      // Apply registry enabled state
      const key = agent.alias || agent.manifest.name;
      const regEntry = registry.agents[key];
      if (regEntry) {
        agent.manifest.enabled = regEntry.enabled;
      }

      // Later tiers override earlier tiers by name
      agentMap.set(key, agent);
    }
  }

  // Prune stale registry entries (registered but no loadable files on disk)
  let registryDirty = false;
  for (const key of Object.keys(registry.agents)) {
    if (agentMap.has(key)) continue;
    // Check both global and project paths before marking as stale
    const globalPath = join(homedir(), ".agav", "agents", key);
    const projectPath = join(cwd, ".agav", "agents", key);
    const checkGlobal = await loadAgent(globalPath, "global");
    const checkProject = await loadAgent(projectPath, "project");
    if (!checkGlobal && !checkProject) {
      delete registry.agents[key];
      registryDirty = true;
    }
  }

  if (registryDirty) {
    await saveRegistry(registry).catch(() => {});
  }

  return Array.from(agentMap.values());
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
