import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import type { WorkflowDefinition } from "./types.js";

const WORKFLOW_EXTENSIONS = [".yaml", ".yml", ".json"];

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  path: string;
}

export function workflowSearchDirs(cwd = process.cwd()): string[] {
  return [join(cwd, ".agav", "workflows"), join(homedir(), ".agav", "workflows")];
}

export async function resolveWorkflowPath(nameOrPath: string, cwd = process.cwd()): Promise<string> {
  const candidates: string[] = [];
  if (looksLikePath(nameOrPath)) {
    const base = isAbsolute(nameOrPath) ? nameOrPath : resolve(cwd, nameOrPath);
    candidates.push(base, ...WORKFLOW_EXTENSIONS.map((ext) => base.endsWith(ext) ? base : `${base}${ext}`));
  } else {
    for (const dir of workflowSearchDirs(cwd)) {
      for (const ext of WORKFLOW_EXTENSIONS) candidates.push(join(dir, `${nameOrPath}${ext}`));
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {}
  }

  throw new Error(`Workflow "${nameOrPath}" not found`);
}

export async function loadWorkflow(nameOrPath: string, cwd = process.cwd()): Promise<LoadedWorkflow> {
  const path = await resolveWorkflowPath(nameOrPath, cwd);
  const raw = await readFile(path, "utf8");
  const parsed = path.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  return { definition: parsed as WorkflowDefinition, path };
}

export async function listWorkflows(cwd = process.cwd()): Promise<LoadedWorkflow[]> {
  const workflows: LoadedWorkflow[] = [];
  const seen = new Set<string>();
  for (const dir of workflowSearchDirs(cwd)) {
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (!WORKFLOW_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      const path = join(dir, entry);
      try {
        const loaded = await loadWorkflow(path, cwd);
        if (seen.has(loaded.definition.name)) continue;
        seen.add(loaded.definition.name);
        workflows.push(loaded);
      } catch {}
    }
  }
  return workflows;
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.startsWith(".") || value.includes("/") || value.includes("\\") || WORKFLOW_EXTENSIONS.some((ext) => value.endsWith(ext));
}
