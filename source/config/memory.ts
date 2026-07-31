import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getAgavDir } from "./config.js";
import { ensureDir } from "../utils/fs.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryFrontmatter {
  name: string;
  description: string;
  metadata: {
    type: MemoryType;
  };
}

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  filePath: string;
  createdAt?: string;
}

function getGitRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    }).toString().trim();
  } catch {
    return process.cwd();
  }
}

function getProjectHash(): string {
  const root = getGitRepoRoot();
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

function getProjectMemoryDir(): string {
  const hash = getProjectHash();
  return join(getAgavDir(), "projects", hash, "memory");
}

function getMemoryIndexPath(): string {
  return join(getProjectMemoryDir(), "MEMORY.md");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseMemoryFile(text: string, filePath: string): MemoryEntry | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1]!;
  const content = match[2]!.trim();

  let name = "unknown";
  let description = "";
  let type: MemoryType = "project";

  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key === "name") name = val;
    else if (key === "description") description = val;
    else if (key === "type") type = val as MemoryType;
  }

  return { name, description, type, content, filePath };
}

function formatMemoryFile(entry: { name: string; description: string; type: MemoryType; content: string }): string {
  return [
    "---",
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    "metadata:",
    `  type: ${entry.type}`,
    "---",
    "",
    entry.content,
    "",
  ].join("\n");
}

export async function saveMemory(entry: {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}): Promise<string> {
  const dir = getProjectMemoryDir();
  await ensureDir(dir);

  const slug = slugify(entry.name);
  const filePath = join(dir, `${slug}.md`);
  await writeFile(filePath, formatMemoryFile(entry));

  await updateMemoryIndex();
  return slug;
}

export async function loadMemories(): Promise<MemoryEntry[]> {
  const dir = getProjectMemoryDir();
  try {
    await ensureDir(dir);
    const files = await readdir(dir);
    const memories: MemoryEntry[] = [];

    for (const file of files) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      try {
        const filePath = join(dir, file);
        const raw = await readFile(filePath, "utf-8");
        const entry = parseMemoryFile(raw, filePath);
        if (entry) memories.push(entry);
      } catch {}
    }

    memories.sort((a, b) => a.name.localeCompare(b.name));
    return memories;
  } catch {
    return [];
  }
}

export async function deleteMemory(name: string): Promise<boolean> {
  const dir = getProjectMemoryDir();
  const slug = slugify(name);

  for (const ext of [".md", ".json"]) {
    try {
      await unlink(join(dir, `${slug}${ext}`));
      await updateMemoryIndex();
      return true;
    } catch {}
  }

  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      const filePath = join(dir, file);
      const raw = await readFile(filePath, "utf-8");
      const entry = parseMemoryFile(raw, filePath);
      if (entry && (entry.name === name || slugify(entry.name) === slug)) {
        await unlink(filePath);
        await updateMemoryIndex();
        return true;
      }
    }
  } catch {}

  return false;
}

export async function deleteAllMemories(): Promise<number> {
  const memories = await loadMemories();
  let count = 0;
  for (const m of memories) {
    try {
      await unlink(m.filePath);
      count++;
    } catch {}
  }
  await updateMemoryIndex();
  return count;
}

async function updateMemoryIndex(): Promise<void> {
  const dir = getProjectMemoryDir();
  await ensureDir(dir);
  const memories = await loadMemories();

  if (memories.length === 0) {
    await writeFile(getMemoryIndexPath(), "# Memories\n\nNo memories saved yet.\n");
    return;
  }

  const lines = memories.map((m) => {
    const slug = slugify(m.name);
    return `- [${m.name}](${slug}.md) — ${m.description}`;
  });

  await writeFile(
    getMemoryIndexPath(),
    `# Memories\n\n${lines.join("\n")}\n`,
  );
}

const MAX_MEMORY_LINES = 200;

export async function formatMemoriesForPrompt(): Promise<string> {
  const memories = await loadMemories();
  if (memories.length === 0) return "";

  const sections: Record<MemoryType, string[]> = {
    user: [],
    feedback: [],
    project: [],
    reference: [],
  };

  for (const m of memories) {
    const links = m.content.match(/\[\[([^\]]+)\]\]/g)?.map((l) => l.slice(2, -2)) ?? [];
    const linkNote = links.length > 0 ? ` (see also: ${links.join(", ")})` : "";
    sections[m.type].push(`- **${m.name}**: ${m.description}${linkNote}`);
  }

  const parts: string[] = [];

  if (sections.user.length > 0) {
    parts.push("**User context:**\n" + sections.user.join("\n"));
  }
  if (sections.feedback.length > 0) {
    parts.push("**Feedback & corrections:**\n" + sections.feedback.join("\n"));
  }
  if (sections.project.length > 0) {
    parts.push("**Project context:**\n" + sections.project.join("\n"));
  }
  if (sections.reference.length > 0) {
    parts.push("**References:**\n" + sections.reference.join("\n"));
  }

  let result = "Memories from previous sessions (per-project, auto-saved):\n\n" + parts.join("\n\n");

  const lines = result.split("\n");
  if (lines.length > MAX_MEMORY_LINES) {
    result = lines.slice(0, MAX_MEMORY_LINES).join("\n") + "\n...(truncated)";
  }

  return result;
}

export function getProjectMemoryPath(): string {
  return getProjectMemoryDir();
}
