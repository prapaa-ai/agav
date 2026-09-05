/**
 * Agent installer - sparse-clone from git repos, validate, and install
 */

import { execFile } from "node:child_process";
import { readdir, rm, cp, mkdir, stat, realpath, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadAgent } from "./loader.js";
import { registerAgent, isAgentRegistered } from "./agent-registry.js";
import type { AgentDefinition } from "./types.js";

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const DEFAULT_ALLOWED_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "raw.githubusercontent.com"]);

function getAllowedHosts(): Set<string> {
  const extra = process.env.AGAV_ALLOWED_GIT_HOSTS;
  if (!extra) return DEFAULT_ALLOWED_HOSTS;
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  for (const h of extra.split(",")) {
    const trimmed = h.trim();
    if (trimmed) hosts.add(trimmed);
  }
  return hosts;
}

function validateAgentName(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Invalid agent name "${name}": must match ${SAFE_NAME}`);
  }
}

function validateGitUrl(url: string): void {
  const parsed = new URL(url);
  const allowed = getAllowedHosts();
  if (!allowed.has(parsed.hostname)) {
    throw new Error(`Untrusted git host: ${parsed.hostname}. Allowed: ${[...allowed].join(", ")}`);
  }
}

export async function assertPathContained(child: string, parent: string): Promise<void> {
  const resolved = await realpath(resolve(child)).catch(() => resolve(child));
  const root = await realpath(resolve(parent)).catch(() => resolve(parent));
  if (!resolved.startsWith(root + "/") && !resolved.startsWith(root + "\\") && resolved !== root) {
    throw new Error("Agent path escapes the agents directory");
  }
}

function gitExec(args: string[], cwd: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 60_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

/**
 * Install agent from a git URL or local path
 */
export async function installAgent(
  source: string,
  options: {
    alias?: string;
    destination?: "global" | "project";
    cwd?: string;
    sourceUrl?: string;
  } = {}
): Promise<{ success: boolean; agent?: AgentDefinition; error?: string; warning?: string }> {
  const { alias, destination = "global", cwd = process.cwd() } = options;

  // Validate alias early (before loading agent or cloning)
  if (alias !== undefined) {
    try {
      validateAgentName(alias);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Determine if source is a git URL or local path
  if (source.startsWith("git@")) {
    return { success: false, error: "SSH (git@) URLs are not supported. Use HTTPS URLs instead." };
  }

  const isGitUrl = source.startsWith("http://") || source.startsWith("https://");

  let agentPath: string;

  if (isGitUrl) {
    // Clone from git repo
    const cloneResult = await cloneAgent(source);
    if (!cloneResult.success || !cloneResult.path) {
      return { success: false, error: cloneResult.error || "Clone failed" };
    }
    agentPath = cloneResult.path;
  } else if (source.startsWith("file://")) {
    // file:// URL — convert to filesystem path
    try {
      agentPath = fileURLToPath(source);
    } catch {
      return { success: false, error: `Invalid file:// URL: ${source}` };
    }
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
  try {
    validateAgentName(nameToCheck);
  } catch (e) {
    if (isGitUrl) await rm(agentPath, { recursive: true, force: true });
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (await isAgentRegistered(nameToCheck)) {
    // Verify the registered agent actually has valid files — it may be a stale/broken entry
    // (e.g. only config.json exists but AGENT.md and tools/ are missing)
    const { loadRegistry } = await import("./agent-registry.js");
    const registry = await loadRegistry();
    const registeredPath =
      destination === "global"
        ? join(homedir(), ".agav", "agents", nameToCheck)
        : join(cwd, ".agav", "agents", nameToCheck);
    const loadedCheck = await loadAgent(registeredPath, "global");
    const isStale = !loadedCheck;

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
  const agentsRoot =
    destination === "global"
      ? join(homedir(), ".agav", "agents")
      : join(cwd, ".agav", "agents");
  const destPath = join(agentsRoot, nameToCheck);
  await assertPathContained(destPath, agentsRoot);

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
      sourceUrl: options.sourceUrl ?? (isGitUrl || source.startsWith("file://") ? source : undefined),
      installedAt: new Date().toISOString(),
      version: agent.manifest.version,
    });

    // Reload agent from final destination
    const finalAgent = await loadAgent(destPath, destination === "global" ? "global" : "project", alias);

    const installed = finalAgent || agent;
    const warning = installed.manifest.type === "a2a" && installed.manifest["start-command"]
      ? `This A2A agent will execute "${installed.manifest["start-command"]}" when invoked. Review the command before use.`
      : undefined;
    return { success: true, agent: installed, warning };
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
  try {
    validateGitUrl(url);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  const tempDir = join(tmpdir(), `agav-agent-${randomBytes(8).toString("hex")}`);

  try {
    await mkdir(tempDir, { recursive: true });

    const isSubdirectory = url.includes("/tree/") || url.includes("/agents/");

    if (isSubdirectory) {
      const match = url.match(/^(https?:\/\/[^\/]+\/[^\/]+\/[^\/]+)(?:\/tree\/[^\/]+)?(\/.+)$/);
      if (!match) {
        return { success: false, error: "Invalid git URL format" };
      }

      const [, repoUrl, subPath] = match;

      await gitExec(["clone", "--depth=1", "--filter=blob:none", "--sparse", repoUrl!, "."], tempDir);
      await gitExec(["sparse-checkout", "set", subPath!.slice(1)], tempDir);

      // Copy agent out of the clone, then clean up (avoids dragging .git into the install)
      const agentSrc = join(tempDir, subPath!.slice(1));
      await assertPathContained(agentSrc, tempDir);
      const outDir = join(tmpdir(), `agav-agent-${randomBytes(8).toString("hex")}`);
      await mkdir(outDir, { recursive: true });
      await cp(agentSrc, outDir, {
        recursive: true,
        filter: (src) => !src.endsWith(".git") && !src.includes(`${join(".git")}/`) && !src.includes(`${join(".git")}\\`),
      });
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return { success: true, path: outDir };
    } else {
      await gitExec(["clone", "--depth=1", url, "."], tempDir);

      const entries = await readdir(tempDir);
      if (entries.includes("AGENT.md")) {
        // Remove .git from the clone before returning
        await rm(join(tempDir, ".git"), { recursive: true, force: true }).catch(() => {});
        return { success: true, path: tempDir };
      } else if (entries.includes("agents")) {
        const agentsDir = join(tempDir, "agents");
        const agentDirs = await readdir(agentsDir);
        // Find first entry that contains an AGENT.md
        for (const dir of agentDirs) {
          const candidate = join(agentsDir, dir);
          const s = await stat(candidate).catch(() => null);
          if (!s?.isDirectory()) continue;
          const candidateEntries = await readdir(candidate);
          if (candidateEntries.includes("AGENT.md")) {
            // Copy out of the clone to avoid dragging .git
            const outDir = join(tmpdir(), `agav-agent-${randomBytes(8).toString("hex")}`);
            await mkdir(outDir, { recursive: true });
            await cp(candidate, outDir, { recursive: true });
            await rm(tempDir, { recursive: true, force: true }).catch(() => {});
            return { success: true, path: outDir };
          }
        }
      }

      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
  try {
    validateAgentName(nameOrAlias);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  const { unregisterAgent } = await import("./agent-registry.js");

  const agentsRoot =
    destination === "global"
      ? join(homedir(), ".agav", "agents")
      : join(cwd, ".agav", "agents");
  const agentPath = join(agentsRoot, nameOrAlias);
  await assertPathContained(agentPath, agentsRoot);

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

/**
 * Download agent files from an HTTP-based marketplace into a temp directory.
 * Returns the temp directory path, which can be passed to installAgent() as a local path.
 */
export async function downloadAgentFiles(
  baseUrl: string,
  files: string[],
): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!files.length) {
    return { success: false, error: "No files to download" };
  }

  for (const f of files) {
    if (!f || f.includes("..") || /^[/\\]/.test(f) || /^[A-Za-z]:/.test(f)) {
      return { success: false, error: `Invalid file path: "${f}"` };
    }
  }

  const tempDir = join(tmpdir(), `agav-agent-${randomBytes(8).toString("hex")}`);

  try {
    await mkdir(tempDir, { recursive: true });

    const results = await Promise.allSettled(
      files.map(async (file) => {
        const url = `${baseUrl}/${file}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${file}`);
        const destPath = join(tempDir, ...file.split("/"));
        await mkdir(dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await res.arrayBuffer());
        await writeFile(destPath, buffer);
      }),
    );

    const failures = results
      .map((r, i) => (r.status === "rejected" ? `${files[i]}: ${r.reason?.message || r.reason}` : null))
      .filter(Boolean);

    if (failures.length) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return { success: false, error: `Failed to download: ${failures.join("; ")}` };
    }

    const entries = await readdir(tempDir);
    if (!entries.includes("AGENT.md")) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return { success: false, error: "Downloaded files do not contain AGENT.md" };
    }

    return { success: true, path: tempDir };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return {
      success: false,
      error: `Download failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
