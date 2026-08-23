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
 *
 * For non-bundled agents (global / project), tool execution is sandboxed
 * in a subprocess wrapped by Seatbelt (macOS) or Bubblewrap (Linux).
 * Bundled agents are trusted and run in-process for performance.
 */
async function scanAgentTools(
  agentDir: string,
  toolsDir: string,
  toolPermissions: Record<string, "safe" | "destructive"> = {},
  manifestTools?: AgentManifest["tools"],
  origin: AgentOrigin = "bundled",
): Promise<ToolDefinition[]> {
  const toolsDirPath = resolve(agentDir, toolsDir);
  const tools: ToolDefinition[] = [];

  let entries: string[];
  try {
    entries = await readdir(toolsDirPath);
  } catch {
    return tools;
  }

  // Index manifest-declared tool schemas by name for quick lookup
  const manifestSchemaByName = new Map<string, NonNullable<AgentManifest["tools"]>[number]>();
  if (manifestTools) {
    for (const t of manifestTools) {
      // Normalize hyphens to underscores to match filename-derived toolName
      const normalized = t.name.replace(/-/g, "_");
      manifestSchemaByName.set(normalized, t);
    }
  }

  for (const entry of entries) {
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) continue;

    const toolPath = join(toolsDirPath, entry);
    const toolName = entry.replace(/\.(mjs|js)$/, "").replace(/-/g, "_");

    // Schema resolution: (1) manifest tools section, (2) .schema.json sidecar, (3) placeholder
    let schema: ToolDefinition["schema"];
    let hasDeclaredSchema = false;
    const manifestEntry = manifestSchemaByName.get(toolName);
    if (manifestEntry) {
      schema = {
        name: manifestEntry.name,
        description: manifestEntry.description,
        destructive: manifestEntry.destructive,
        inputSchema: manifestEntry.inputSchema,
      };
      hasDeclaredSchema = true;
    } else {
      const sidecarPath = toolPath.replace(/\.(mjs|js)$/, ".schema.json");
      try {
        const sidecar = await readFile(sidecarPath, "utf-8");
        schema = JSON.parse(sidecar);
        // Sanitize schema name to prevent path traversal (e.g. in tool-gen.ts write paths)
        if (schema.name && /[\/\\]/.test(schema.name)) {
          console.warn(`[agent] Sidecar schema name "${schema.name}" contains path separators, using filename-derived name`);
          schema.name = toolName;
        }
        hasDeclaredSchema = true;
      } catch {
        console.warn(`[agent] No schema for tool "${toolName}" in ${agentDir} — declare it in AGENT.md tools section or provide a .schema.json sidecar`);
        schema = {
          name: toolName,
          description: `Tool: ${toolName}`,
          inputSchema: {
            type: "object" as const,
            properties: { task: { type: "string", description: "The task input" } },
            required: ["task"],
          },
        };
      }
    }

    // Apply tool permission from manifest
    const permission = toolPermissions[schema.name];
    if (permission === "safe") {
      schema.destructive = false;
    } else if (permission === "destructive") {
      schema.destructive = true;
    }

    // Non-bundled agents run in a sandboxed subprocess; bundled agents
    // are trusted and execute in-process for performance.
    if (origin !== "bundled") {
      tools.push({
        schema,
        async execute(input, context?) {
          const { executeSandboxedTool } = await import("./sandboxed-tool.js");
          return await executeSandboxedTool(toolPath, input, context?.env);
        },
      });
    } else {
      // Bundled (trusted) path — lazy in-process import
      let loadedExecute: ((input: Record<string, unknown>) => Promise<any>) | null = null;

      tools.push({
        schema,
        async execute(input, context?) {
          // Inject credentials into process.env for this tool call only
          const envToRestore: Record<string, string | undefined> = {};
          if (context?.env) {
            for (const [k, v] of Object.entries(context.env)) {
              envToRestore[k] = process.env[k];
              process.env[k] = v;
            }
          }
          try {
            if (!loadedExecute) {
              const mod = await import(pathToFileURL(toolPath).href);
              const toolDef = mod.default || mod;
              if (!toolDef.execute) {
                return { output: `Tool ${schema.name} has no execute function`, isError: true };
              }
              // Only update schema from the module if no manifest/sidecar schema was declared
              if (toolDef.schema && !hasDeclaredSchema) {
                Object.assign(schema, toolDef.schema);
                if (permission === "safe") schema.destructive = false;
                else if (permission === "destructive") schema.destructive = true;
              }
              loadedExecute = toolDef.execute;
            }
            return await loadedExecute!(input);
          } finally {
            for (const [k, v] of Object.entries(envToRestore)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
          }
        },
      });
    }
  }

  return tools;
}

/**
 * Load only the manifest (no tool scanning) — used for disabled agents
 * so they appear in the TUI list without executing any tool code.
 */
async function loadAgentManifestOnly(agentDir: string, origin: AgentOrigin, alias?: string): Promise<AgentDefinition | null> {
  const manifestPath = join(agentDir, "AGENT.md");
  try {
    await stat(manifestPath);
  } catch {
    return null;
  }
  try {
    const { manifest, systemPrompt } = await parseAgentMarkdown(manifestPath);
    return {
      manifest: { ...manifest, enabled: false },
      systemPrompt,
      tools: [],
      origin,
      path: agentDir,
      alias,
    };
  } catch {
    return null;
  }
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
    const tools = await scanAgentTools(agentDir, toolsDir, manifest["tool-permissions"], manifest.tools, origin);

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

      // Disabled agents are loaded (so they appear in the TUI list) but
      // their tools are not scanned (no code execution for disabled agents).
      const registryEntry = registry.agents[entry];
      const isDisabled = registryEntry && registryEntry.enabled === false;

      const agent = isDisabled
        ? await loadAgentManifestOnly(agentDir, origin)
        : await loadAgent(agentDir, origin);
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
