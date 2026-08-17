/**
 * Agent installer - sparse-clone from git repos, validate, and install
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readdir, rm, cp, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { loadAgent } from "./loader.js";
import { registerAgent, isAgentRegistered } from "./agent-registry.js";
import type { AgentDefinition } from "./types.js";

const execAsync = promisify(exec);

/**
 * Install agent from a git URL or local path
 */
export async function installAgent(
  source: string,
  options: {
    alias?: string;
    destination?: "global" | "project";
    cwd?: string;
  } = {}
): Promise<{ success: boolean; agent?: AgentDefinition; error?: string }> {
  const { alias, destination = "global", cwd = process.cwd() } = options;

  // Determine if source is a git URL or local path
  const isGitUrl = source.startsWith("http://") || source.startsWith("https://") || source.startsWith("git@");

  let agentPath: string;

  if (isGitUrl) {
    // Clone from git repo
    const cloneResult = await cloneAgent(source);
    if (!cloneResult.success || !cloneResult.path) {
      return { success: false, error: cloneResult.error || "Clone failed" };
    }
    agentPath = cloneResult.path;
  } else {
    // Local path
    agentPath = source;
  }

  // Load and validate agent
  const agent = await loadAgent(agentPath, "global", alias);
  if (!agent) {
    if (isGitUrl) {
      // Clean up temp clone
      await rm(agentPath, { recursive: true, force: true });
    }
    return { success: false, error: "Invalid agent: could not load AGENT.md" };
  }

  // Check for name conflict
  const nameToCheck = alias || agent.manifest.name;
  if (await isAgentRegistered(nameToCheck)) {
    // Verify the registered agent actually has valid files — it may be a stale/broken entry
    // (e.g. only config.json exists but AGENT.md and tools/ are missing)
    const { loadRegistry } = await import("./agent-registry.js");
    const registry = await loadRegistry();
    const registryEntry = registry.agents[nameToCheck];
    const { homedir: getHome } = await import("node:os");
    const registeredPath = join(getHome(), ".agav", "agents", nameToCheck);
    const loadedCheck = await loadAgent(registeredPath, "global");
    const isStale = !loadedCheck; // can't load = stale/broken entry

    if (!isStale) {
      // Agent is genuinely installed and healthy — block as before
      if (isGitUrl) await rm(agentPath, { recursive: true, force: true });
      return {
        success: false,
        error: `Agent '${nameToCheck}' is already installed. Use --alias to install with a different name.`,
      };
    }

    // Stale entry: remove it from the registry and proceed with fresh install
    delete registry.agents[nameToCheck];
    const { saveRegistry } = await import("./agent-registry.js");
    await saveRegistry(registry);
  }

  // Determine install destination
  const destPath =
    destination === "global"
      ? join(homedir(), ".agav", "agents", nameToCheck)
      : join(cwd, ".agav", "agents", nameToCheck);

  // Copy agent to destination
  try {
    await mkdir(join(destPath, ".."), { recursive: true });
    await cp(agentPath, destPath, { recursive: true });

    // If cloned from git, clean up temp directory
    if (isGitUrl) {
      await rm(agentPath, { recursive: true, force: true });
    }

    // Register agent
    await registerAgent({
      name: agent.manifest.name,
      alias,
      enabled: true,
      sourceUrl: isGitUrl ? source : undefined,
      installedAt: new Date().toISOString(),
      version: agent.manifest.version,
    });

    // Reload agent from final destination
    const finalAgent = await loadAgent(destPath, destination === "global" ? "global" : "project", alias);

    return { success: true, agent: finalAgent || agent };
  } catch (error) {
    if (isGitUrl) {
      await rm(agentPath, { recursive: true, force: true });
    }
    return {
      success: false,
      error: `Failed to install agent: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Clone agent from git URL using sparse checkout
 */
async function cloneAgent(url: string): Promise<{ success: boolean; path?: string; error?: string }> {
  // Create temp directory
  const tempDir = join(tmpdir(), `agav-agent-${randomBytes(8).toString("hex")}`);

  try {
    await mkdir(tempDir, { recursive: true });

    // Parse URL to determine if it's a subdirectory or full repo
    const isSubdirectory = url.includes("/tree/") || url.includes("/agents/");

    if (isSubdirectory) {
      // Extract repo URL and path
      const match = url.match(/^(https?:\/\/[^\/]+\/[^\/]+\/[^\/]+)(?:\/tree\/[^\/]+)?(\/.+)$/);
      if (!match) {
        return { success: false, error: "Invalid git URL format" };
      }

      const [, repoUrl, subPath] = match;

      // Sparse checkout
      await execAsync(`git clone --depth=1 --filter=blob:none --sparse "${repoUrl}" .`, { cwd: tempDir });
      await execAsync(`git sparse-checkout set ${subPath.slice(1)}`, { cwd: tempDir });

      // Find the agent directory
      const agentPath = join(tempDir, subPath.slice(1));
      return { success: true, path: agentPath };
    } else {
      // Full repo clone
      await execAsync(`git clone --depth=1 "${url}" .`, { cwd: tempDir });

      // Look for agents/ directory or assume root is the agent
      const entries = await readdir(tempDir);
      if (entries.includes("AGENT.md")) {
        return { success: true, path: tempDir };
      } else if (entries.includes("agents")) {
        // Multiple agents - return the first one found
        const agentsDir = join(tempDir, "agents");
        const agentDirs = await readdir(agentsDir);
        if (agentDirs.length > 0) {
          return { success: true, path: join(agentsDir, agentDirs[0]) };
        }
      }

      return { success: false, error: "No AGENT.md found in repository" };
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return {
      success: false,
      error: `Git clone failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Uninstall agent (remove from filesystem and registry)
 */
export async function uninstallAgent(nameOrAlias: string, destination: "global" | "project" = "global", cwd: string = process.cwd()): Promise<{ success: boolean; error?: string }> {
  const { unregisterAgent } = await import("./agent-registry.js");
  const { stat } = await import("node:fs/promises");

  const agentPath =
    destination === "global"
      ? join(homedir(), ".agav", "agents", nameOrAlias)
      : join(cwd, ".agav", "agents", nameOrAlias);

  // Verify the path exists (registry entry is optional — agents can exist on disk
  // without a registry entry if the registry was pruned or manually edited)
  try {
    await stat(agentPath);
  } catch {
    return { success: false, error: `Agent '${nameOrAlias}' not found at ${agentPath}` };
  }

  try {
    await rm(agentPath, { recursive: true, force: true });
    // Remove from registry if present — non-fatal if already absent
    await unregisterAgent(nameOrAlias).catch(() => {});
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to uninstall: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
