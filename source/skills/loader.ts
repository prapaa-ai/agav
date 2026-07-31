import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgavDir } from "../config/config.js";
import type { SkillFrontmatter, SkillDefinition } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedSkills: SkillDefinition[] | null = null;

export function parseSkillMarkdown(text: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: { name: "unknown", description: "" }, body: text };
  }

  const yamlBlock = match[1]!;
  const body = match[2]!.trim();

  const fm: Record<string, unknown> = {};
  const lines = yamlBlock.split("\n");
  let currentKey = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const listItem = line.match(/^\s+-\s+(.+)$/);

    if (listItem) {
      if (currentKey && fm[currentKey]) {
        (fm[currentKey] as string[]).push(listItem[1]!.trim().replace(/^["']|["']$/g, ""));
      }
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let val: unknown = line.slice(colonIdx + 1).trim();

    if (val === "") {
      fm[key] = [] as string[];
      currentKey = key;
      continue;
    }

    currentKey = "";
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (typeof val === "string" && (val.startsWith('"') || val.startsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }

  return {
    frontmatter: {
      name: String(fm.name ?? "unknown"),
      description: String(fm.description ?? ""),
      version: fm.version ? String(fm.version) : undefined,
      invocation: (fm.invocation as SkillFrontmatter["invocation"]) ?? "both",
      "allowed-tools": fm["allowed-tools"] as string[] | undefined,
      "disallowed-tools": fm["disallowed-tools"] as string[] | undefined,
      model: fm.model ? String(fm.model) : undefined,
      effort: fm.effort as SkillFrontmatter["effort"],
      tags: fm.tags as string[] | undefined,
    },
    body,
  };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function scanDir(dir: string, origin: SkillDefinition["origin"]): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, "SKILL.md");
      try {
        const text = await readFile(skillPath, "utf-8");
        const { frontmatter, body } = parseSkillMarkdown(text);
        skills.push({
          name: frontmatter.name,
          slug: slugify(frontmatter.name),
          description: frontmatter.description,
          body,
          frontmatter,
          filePath: skillPath,
          origin,
        });
      } catch {}
    }
  } catch {}
  return skills;
}

export async function loadSkills(): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  const seen = new Set<string>();

  const bundledDir = join(__dirname, "bundled");
  for (const s of await scanDir(bundledDir, "bundled")) {
    if (!seen.has(s.slug)) { seen.add(s.slug); skills.push(s); }
  }

  const globalDir = join(getAgavDir(), "skills");
  for (const s of await scanDir(globalDir, "global")) {
    if (!seen.has(s.slug)) { seen.add(s.slug); skills.push(s); }
  }

  const projectDir = join(process.cwd(), ".agav", "skills");
  for (const s of await scanDir(projectDir, "project")) {
    if (seen.has(s.slug)) {
      const idx = skills.findIndex((x) => x.slug === s.slug);
      if (idx >= 0) skills[idx] = s;
    } else {
      seen.add(s.slug);
      skills.push(s);
    }
  }

  cachedSkills = skills;
  return skills;
}

export function getCachedSkills(): SkillDefinition[] {
  return cachedSkills ?? [];
}

export function getSkill(name: string): SkillDefinition | undefined {
  const slug = slugify(name);
  return (cachedSkills ?? []).find((s) => s.slug === slug || s.name === name);
}

export function buildSkillCatalog(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const inv = s.frontmatter.invocation ?? "both";
    const label = inv === "both" ? "auto+manual" : inv === "agav" ? "auto" : "manual";
    return `- ${s.name}: ${s.description} [${label}]`;
  });
  return [
    "Available skills — this list is authoritative, do NOT search the filesystem to discover skills.",
    "When a task matches a skill, use the activate_skill tool to run it instead of doing the work manually.",
    "When the user asks what skills are available, answer from this list directly.",
    'When the user message starts with [skill:<name>], immediately call activate_skill with that name and any text after it as arguments. Do not create a plan.',
    "",
    ...lines,
  ].join("\n");
}
