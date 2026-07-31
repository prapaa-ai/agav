import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgavDir } from "../config/config.js";
import { validateSkill } from "./validate.js";
import { ensureDir } from "../utils/fs.js";

interface MarketplaceSkill {
  name: string;
  description: string;
  url: string;
}

const GITHUB_API = "https://api.github.com/repos/anthropics/skills/contents/skills";
const RAW_BASE = "https://raw.githubusercontent.com/anthropics/skills/main/skills";

export async function fetchMarketplaceIndex(): Promise<MarketplaceSkill[]> {
  try {
    const res = await fetch(GITHUB_API, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) return getFallbackSkills();
    const entries = (await res.json()) as { name: string; type: string }[];
    if (!Array.isArray(entries)) return getFallbackSkills();
    return entries
      .filter((e) => e.type === "dir")
      .map((e) => ({
        name: e.name,
        description: `Skill from anthropics/skills repository`,
        url: `${RAW_BASE}/${e.name}/SKILL.md`,
      }));
  } catch {
    return getFallbackSkills();
  }
}

function getFallbackSkills(): MarketplaceSkill[] {
  return [
    { name: "algorithmic-art", description: "Generate algorithmic art and creative visuals", url: `${RAW_BASE}/algorithmic-art/SKILL.md` },
    { name: "brand-guidelines", description: "Create and enforce brand guidelines", url: `${RAW_BASE}/brand-guidelines/SKILL.md` },
    { name: "canvas-design", description: "Design interactive canvas-based visuals", url: `${RAW_BASE}/canvas-design/SKILL.md` },
    { name: "claude-api", description: "Work with the Claude API effectively", url: `${RAW_BASE}/claude-api/SKILL.md` },
    { name: "doc-coauthoring", description: "Collaborative document co-authoring", url: `${RAW_BASE}/doc-coauthoring/SKILL.md` },
    { name: "frontend-design", description: "Design frontend interfaces and components", url: `${RAW_BASE}/frontend-design/SKILL.md` },
    { name: "mcp-builder", description: "Build MCP server integrations", url: `${RAW_BASE}/mcp-builder/SKILL.md` },
    { name: "skill-creator", description: "Create new Agent Skills", url: `${RAW_BASE}/skill-creator/SKILL.md` },
    { name: "web-artifacts-builder", description: "Build interactive web artifacts", url: `${RAW_BASE}/web-artifacts-builder/SKILL.md` },
    { name: "webapp-testing", description: "Test web applications thoroughly", url: `${RAW_BASE}/webapp-testing/SKILL.md` },
  ];
}

export async function installFromUrl(url: string): Promise<{ name: string; warnings: string[] } | { error: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `Failed to fetch: ${res.status}` };
    const markdown = await res.text();

    const { passed, warnings } = validateSkill(markdown);
    if (!passed) {
      return { error: `Validation failed:\n${warnings.join("\n")}` };
    }

    const frontmatterMatch = markdown.match(/^---\r?\n[\s\S]*?name:\s*(.+)/m);
    const name = frontmatterMatch?.[1]?.trim() ?? "imported-skill";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const skillDir = join(getAgavDir(), "skills", slug);
    await ensureDir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), markdown);

    return { name, warnings };
  } catch (err) {
    return { error: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function installFromPath(sourcePath: string): Promise<{ name: string; warnings: string[] } | { error: string }> {
  try {
    const { readFile: rf } = await import("node:fs/promises");
    const markdown = await rf(sourcePath, "utf-8");

    const { passed, warnings } = validateSkill(markdown);
    if (!passed) {
      return { error: `Validation failed:\n${warnings.join("\n")}` };
    }

    const frontmatterMatch = markdown.match(/^---\r?\n[\s\S]*?name:\s*(.+)/m);
    const name = frontmatterMatch?.[1]?.trim() ?? "imported-skill";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const skillDir = join(getAgavDir(), "skills", slug);
    await ensureDir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), markdown);

    return { name, warnings };
  } catch (err) {
    return { error: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function removeSkill(name: string): Promise<boolean> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const skillDir = join(getAgavDir(), "skills", slug);
  try {
    const { rm } = await import("node:fs/promises");
    await rm(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
