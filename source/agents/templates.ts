import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface AgentTemplate {
  name: string;
  description: string;
  systemPrompt: string;
  mcpServers?: Array<{ key: string; command: string; args?: string[] }>;
  tags?: string[];
  savedAt: string;
}

const TEMPLATES_PATH = join(homedir(), ".agav", "agents", "templates.json");

let lockQueue: Promise<void> = Promise.resolve();
function acquireLock(): Promise<() => void> {
  let release!: () => void;
  const prev = lockQueue;
  lockQueue = new Promise<void>((resolve) => { release = resolve; });
  return prev.then(() => release);
}

async function readTemplates(): Promise<AgentTemplate[]> {
  try {
    const data = await readFile(TEMPLATES_PATH, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeTemplates(templates: AgentTemplate[]): Promise<void> {
  await mkdir(join(homedir(), ".agav", "agents"), { recursive: true });
  const tmpPath = TEMPLATES_PATH + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(tmpPath, JSON.stringify(templates, null, 2), "utf-8");
  await rename(tmpPath, TEMPLATES_PATH);
}

export async function loadTemplates(): Promise<AgentTemplate[]> {
  return readTemplates();
}

export async function saveTemplate(template: AgentTemplate): Promise<void> {
  const release = await acquireLock();
  try {
    const templates = await readTemplates();
    const idx = templates.findIndex((t) => t.name === template.name);
    if (idx >= 0) templates[idx] = template;
    else templates.push(template);
    await writeTemplates(templates);
  } finally {
    release();
  }
}

export async function removeTemplate(name: string): Promise<void> {
  const release = await acquireLock();
  try {
    const templates = await readTemplates();
    const filtered = templates.filter((t) => t.name !== name);
    await writeTemplates(filtered);
  } finally {
    release();
  }
}
