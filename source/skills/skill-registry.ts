/**
 * Skill registry - manages ~/.agav/skills/registry.json
 *
 * Bundled skills are compiled into the binary and cannot be deleted from disk,
 * so the only way to turn one off is to record that choice in a registry the
 * loader consults. The same registry also disables global/project skills without
 * removing their files. Mirrors the agent registry (agents/agent-registry.ts).
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getAgavDir } from "../config/config.js";
import { slugify } from "./skill-utils.js";

export interface SkillRegistryEntry {
  /** Skill slug (slugified name). */
  slug: string;
  /** When false, the skill is hidden from the catalog and cannot be invoked. */
  enabled: boolean;
}

export interface SkillRegistry {
  skills: Record<string, SkillRegistryEntry>; // keyed by slug
}

function registryPath(): string {
  return join(getAgavDir(), "skills", "registry.json");
}

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

export async function loadSkillRegistry(): Promise<SkillRegistry> {
  try {
    const content = await readFile(registryPath(), "utf-8");
    try {
      const parsed = JSON.parse(content) as Partial<SkillRegistry>;
      return { skills: parsed.skills ?? {} };
    } catch (parseErr) {
      console.warn(`[skill-registry] Failed to parse ${registryPath()}, starting fresh:`, parseErr);
      return { skills: {} };
    }
  } catch {
    return { skills: {} };
  }
}

export async function saveSkillRegistry(registry: SkillRegistry): Promise<void> {
  const dir = join(getAgavDir(), "skills");
  await mkdir(dir, { recursive: true });
  const path = registryPath();
  const tmpPath = path + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
  await rename(tmpPath, path);
}

/**
 * Set a skill's enabled state. Disabling a bundled skill records an entry so the
 * loader skips it; re-enabling simply flips the flag back.
 */
export async function setSkillEnabled(nameOrSlug: string, enabled: boolean): Promise<void> {
  const slug = slugify(nameOrSlug);
  const release = await acquireRegistryLock();
  try {
    const registry = await loadSkillRegistry();
    registry.skills[slug] = { slug, enabled };
    await saveSkillRegistry(registry);
  } finally {
    release();
  }
}

/** A skill is disabled only when an entry exists and is explicitly disabled. */
export function isSkillDisabled(slug: string, registry: SkillRegistry): boolean {
  const entry = registry.skills[slug];
  return entry !== undefined && entry.enabled === false;
}
