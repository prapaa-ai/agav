import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

export interface AgentTemplate {
  name: string;
  description: string;
  systemPrompt: string;
  mcpServers?: Array<{ key: string; command: string; args?: string[] }>;
  tags?: string[];
  savedAt: string;
}

const TEMPLATES_PATH = join(homedir(), ".agav", "agents", "templates.json");

export async function loadTemplates(): Promise<AgentTemplate[]> {
  try {
    const data = await readFile(TEMPLATES_PATH, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveTemplate(template: AgentTemplate): Promise<void> {
  const templates = await loadTemplates();
  const idx = templates.findIndex((t) => t.name === template.name);
  if (idx >= 0) templates[idx] = template;
  else templates.push(template);
  await mkdir(join(homedir(), ".agav", "agents"), { recursive: true });
  await writeFile(TEMPLATES_PATH, JSON.stringify(templates, null, 2), "utf-8");
}

export async function removeTemplate(name: string): Promise<void> {
  const templates = await loadTemplates();
  const filtered = templates.filter((t) => t.name !== name);
  await writeFile(TEMPLATES_PATH, JSON.stringify(filtered, null, 2), "utf-8");
}
