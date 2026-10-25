import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { getAgavDir } from "../config/config.js";
import { WORKFLOW_EXTENSIONS } from "./definition.js";

export type WorkflowOrigin = "project" | "user";
export interface DiscoveredWorkflow {
  /** File name without extension; the name used by `run <name>`. */
  name: string;
  path: string;
  origin: WorkflowOrigin;
}
export interface DiscoveryOptions {
  /** Override for the user directory (defaults to `~/.agav/workflows`). */
  userDir?: string;
}
/** Workflow names map to file names; keep them to safe identifiers (no path separators or dots). */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function projectWorkflowsDir(cwd: string): string { return join(cwd, ".agav", "workflows"); }
export function userWorkflowsDir(): string { return join(getAgavDir(), "workflows"); }

async function scan(dir: string, origin: WorkflowOrigin): Promise<DiscoveredWorkflow[]> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return []; throw error; }
  const found = new Map<string, DiscoveredWorkflow>();
  // Sorted so that, within one directory, `.json` wins over `.yaml` over `.yml` for the same name deterministically.
  const rank = (path: string): number => WORKFLOW_EXTENSIONS.indexOf(extname(path).toLowerCase() as typeof WORKFLOW_EXTENSIONS[number]);
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!WORKFLOW_EXTENSIONS.includes(ext as typeof WORKFLOW_EXTENSIONS[number])) continue;
    const name = basename(entry.name, extname(entry.name));
    if (!NAME_PATTERN.test(name)) continue;
    const path = join(dir, entry.name);
    const existing = found.get(name);
    if (!existing || rank(path) < rank(existing.path)) found.set(name, { name, path, origin });
  }
  return [...found.values()];
}

/** Project (`<cwd>/.agav/workflows`) and user (`~/.agav/workflows`) workflows; a project workflow shadows a user one of the same name. */
export async function discoverWorkflows(cwd: string, options: DiscoveryOptions = {}): Promise<DiscoveredWorkflow[]> {
  const [project, user] = await Promise.all([scan(projectWorkflowsDir(cwd), "project"), scan(options.userDir ?? userWorkflowsDir(), "user")]);
  const byName = new Map<string, DiscoveredWorkflow>();
  for (const workflow of [...user, ...project]) byName.set(workflow.name, workflow);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the operand should be treated as a file path rather than a workflow name. */
export function looksLikeWorkflowPath(nameOrPath: string): boolean {
  return isAbsolute(nameOrPath) || /[\\/]/.test(nameOrPath) || WORKFLOW_EXTENSIONS.includes(extname(nameOrPath).toLowerCase() as typeof WORKFLOW_EXTENSIONS[number]);
}

/**
 * Resolves a workflow operand to a definition file. Paths (containing a separator or a
 * workflow extension) resolve relative to `cwd`; bare names are looked up via discovery.
 */
export async function resolveWorkflow(nameOrPath: string, cwd: string, options: DiscoveryOptions = {}): Promise<DiscoveredWorkflow | { name: string; path: string; origin: "path" }> {
  if (!nameOrPath) throw new Error("Missing workflow name or path.");
  if (looksLikeWorkflowPath(nameOrPath)) {
    const path = resolve(cwd, nameOrPath);
    return { name: basename(path, extname(path)), path, origin: "path" };
  }
  const match = (await discoverWorkflows(cwd, options)).find(workflow => workflow.name === nameOrPath);
  if (!match) throw new Error(`Workflow not found: ${nameOrPath} (searched ${projectWorkflowsDir(cwd)} and ${options.userDir ?? userWorkflowsDir()}).`);
  return match;
}
