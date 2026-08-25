import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
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

/**
 * Directories the spec reserves for a skill's supporting files. Used when the
 * user names a bare SKILL.md rather than a skill directory: copying every
 * sibling would drag in the rest of whatever folder the file happens to sit in.
 */
const SPEC_ASSET_DIRS = ["scripts", "references", "assets"];

// Ceilings on what one install may pull in. A skill is documentation and small
// helper scripts; anything past this is a repository that happens to contain a
// SKILL.md, and silently copying it would be a surprise.
const MAX_ASSET_FILES = 200;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);

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

function skillNameFrom(markdown: string): string {
  const frontmatterMatch = markdown.match(/^---\r?\n[\s\S]*?name:\s*(.+)/m);
  return frontmatterMatch?.[1]?.trim().replace(/^["']|["']$/g, "") || "imported-skill";
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * A GitHub raw URL for a SKILL.md, decomposed so the rest of the skill directory
 * can be listed through the contents API. Returns undefined for anything else —
 * an arbitrary host offers no way to discover the sibling files.
 */
function parseGitHubSkillUrl(url: string): { owner: string; repo: string; ref: string; dir: string } | undefined {
  const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)\/SKILL\.md$/);
  if (raw) return { owner: raw[1]!, repo: raw[2]!, ref: raw[3]!, dir: raw[4]! };
  return undefined;
}

/**
 * Rewrites the URLs people actually copy out of a browser. A `blob` or `tree`
 * page serves HTML, which fails validation with a message about missing
 * frontmatter rather than anything the user can act on.
 */
function normaliseSkillUrl(url: string): string {
  const blob = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;

  const tree = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+?)\/?$/);
  if (tree) return `https://raw.githubusercontent.com/${tree[1]}/${tree[2]}/${tree[3]}/SKILL.md`;

  if (/^https:\/\/raw\.githubusercontent\.com\/.+/.test(url) && !/\.md$/.test(url)) {
    return `${url.replace(/\/$/, "")}/SKILL.md`;
  }
  return url;
}

interface GitHubEntry {
  name: string;
  type: string;
  path: string;
  size?: number;
  download_url?: string | null;
}

/** Downloads everything alongside SKILL.md, one directory level at a time. */
async function fetchGitHubAssets(
  src: { owner: string; repo: string; ref: string; dir: string },
  destDir: string,
): Promise<string[]> {
  const warnings: string[] = [];
  let files = 0;
  let bytes = 0;
  let truncated = false;

  const walk = async (apiPath: string, localDir: string): Promise<void> => {
    if (truncated) return;
    const api = `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${apiPath}?ref=${encodeURIComponent(src.ref)}`;
    const res = await fetch(api, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) {
      warnings.push(`Could not list ${apiPath} (HTTP ${res.status}) — its files were not installed.`);
      return;
    }
    const entries = (await res.json()) as GitHubEntry[];
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === "SKILL.md" && localDir === destDir) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      if (entry.type === "dir") {
        await walk(entry.path, join(localDir, entry.name));
        continue;
      }
      if (entry.type !== "file" || !entry.download_url) continue;

      if (files + 1 > MAX_ASSET_FILES || bytes + (entry.size ?? 0) > MAX_ASSET_BYTES) {
        truncated = true;
        warnings.push(
          `Skill exceeds the install limit (${MAX_ASSET_FILES} files / ${MAX_ASSET_BYTES / 1024 / 1024}MB). ` +
            `Remaining files were skipped; the skill may be incomplete.`,
        );
        return;
      }

      const fileRes = await fetch(entry.download_url, { signal: AbortSignal.timeout(15_000) });
      if (!fileRes.ok) {
        warnings.push(`Could not download ${entry.path} (HTTP ${fileRes.status}).`);
        continue;
      }
      const buf = Buffer.from(await fileRes.arrayBuffer());
      await ensureDir(localDir);
      await writeFile(join(localDir, entry.name), buf);
      files++;
      bytes += buf.byteLength;
    }
  };

  await walk(src.dir, destDir);
  if (files > 0) warnings.push(`Installed ${files} supporting file${files === 1 ? "" : "s"} alongside SKILL.md.`);
  return warnings;
}

/** Refuses before copying rather than half-way through it. */
async function measureTree(dir: string): Promise<{ files: number; bytes: number } | undefined> {
  let files = 0;
  let bytes = 0;

  const walk = async (current: string): Promise<boolean> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(full))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      bytes += (await stat(full)).size;
      if (files > MAX_ASSET_FILES || bytes > MAX_ASSET_BYTES) return false;
    }
    return true;
  };

  return (await walk(dir)) ? { files, bytes } : undefined;
}

async function copyTree(srcDir: string, destDir: string): Promise<number> {
  let copied = 0;
  await cp(srcDir, destDir, {
    recursive: true,
    filter: (source) => {
      const rel = relative(srcDir, source);
      if (rel && rel.split(sep).some((part) => SKIP_DIRS.has(part))) return false;
      if (rel) copied++;
      return true;
    },
  });
  return copied;
}

export async function installFromUrl(url: string): Promise<{ name: string; warnings: string[] } | { error: string }> {
  try {
    const target = normaliseSkillUrl(url);
    const res = await fetch(target, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `Failed to fetch: ${res.status}` };
    const markdown = await res.text();

    const github = parseGitHubSkillUrl(target);
    const { passed, warnings } = validateSkill(markdown, {
      dirName: github ? basename(github.dir) : undefined,
    });
    if (!passed) {
      return { error: `Validation failed:\n${warnings.join("\n")}` };
    }

    const name = skillNameFrom(markdown);
    const skillDir = join(getAgavDir(), "skills", slugify(name));
    await ensureDir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), markdown);

    // A skill is a directory, not a file: scripts/, references/ and assets/ are
    // part of it, and a body that says "run scripts/extract.py" is broken
    // without them. GitHub exposes a listing so they can be followed; other
    // hosts do not, so say plainly that only the one file arrived.
    if (github) {
      warnings.push(...(await fetchGitHubAssets(github, skillDir)));
    } else {
      warnings.push("Only SKILL.md was fetched — this host offers no directory listing, so any scripts/, references/ or assets/ the skill ships were not installed.");
    }

    return { name, warnings };
  } catch (err) {
    return { error: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function installFromPath(sourcePath: string): Promise<{ name: string; warnings: string[] } | { error: string }> {
  try {
    const info = await stat(sourcePath).catch(() => undefined);
    if (!info) return { error: `No such file or directory: ${sourcePath}` };

    // Naming the directory means "install this skill" and takes the whole tree.
    // Naming a SKILL.md takes only the directories the spec reserves, since the
    // file may well be sitting in a downloads folder full of unrelated things.
    const isDir = info.isDirectory();
    const srcDir = isDir ? sourcePath : dirname(sourcePath);
    const mdPath = isDir ? join(sourcePath, "SKILL.md") : sourcePath;

    const markdown = await readFile(mdPath, "utf-8").catch(() => undefined);
    if (markdown === undefined) {
      return { error: isDir ? `No SKILL.md in ${sourcePath}` : `Could not read ${sourcePath}` };
    }

    const { passed, warnings } = validateSkill(markdown, { dirName: basename(srcDir) });
    if (!passed) {
      return { error: `Validation failed:\n${warnings.join("\n")}` };
    }

    const name = skillNameFrom(markdown);
    const destDir = join(getAgavDir(), "skills", slugify(name));

    if (isDir) {
      const size = await measureTree(srcDir);
      if (!size) {
        return {
          error: `Skill directory exceeds the install limit (${MAX_ASSET_FILES} files / ${MAX_ASSET_BYTES / 1024 / 1024}MB).`,
        };
      }
      await ensureDir(destDir);
      const copied = await copyTree(srcDir, destDir);
      if (copied > 1) warnings.push(`Installed ${copied - 1} supporting file${copied === 2 ? "" : "s"} alongside SKILL.md.`);
    } else {
      await ensureDir(destDir);
      await writeFile(join(destDir, "SKILL.md"), markdown);
      const found: string[] = [];
      for (const assetDir of SPEC_ASSET_DIRS) {
        const src = join(srcDir, assetDir);
        if (!(await stat(src).then((s) => s.isDirectory()).catch(() => false))) continue;
        if (!(await measureTree(src))) {
          warnings.push(`Skipped ${assetDir}/ — it exceeds the install limit.`);
          continue;
        }
        await copyTree(src, join(destDir, assetDir));
        found.push(assetDir);
      }
      if (found.length > 0) warnings.push(`Also installed: ${found.map((d) => `${d}/`).join(", ")}`);
    }

    return { name, warnings };
  } catch (err) {
    return { error: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function removeSkill(name: string): Promise<boolean> {
  // Same slug the install wrote, hyphen trimming included, or a skill named
  // "PDF Tools " would be installed to pdf-tools and looked for at pdf-tools-.
  const skillDir = join(getAgavDir(), "skills", slugify(name));
  try {
    const { rm } = await import("node:fs/promises");
    await rm(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
