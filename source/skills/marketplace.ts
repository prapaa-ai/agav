import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { getAgavDir } from "../config/config.js";
import { validateSkill } from "./validate.js";
import { slugify } from "./skill-utils.js";
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

/** Turns AbortError / TypeError / generic errors into something the user can act on. */
function describeNetworkError(err: unknown): string {
  if (err instanceof DOMException || (err instanceof Error && err.name === "AbortError")) {
    return "request timed out — check your network connection and try again";
  }
  if (err instanceof TypeError) {
    return `network error — ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

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

/**
 * A GitHub raw URL for a SKILL.md, decomposed so the rest of the skill directory
 * can be listed through the contents API. Returns undefined for anything else —
 * an arbitrary host offers no way to discover the sibling files.
 */
function parseGitHubSkillUrl(url: string): { owner: string; repo: string; ref: string; dir: string } | undefined {
  // Skill inside a subdirectory: owner/repo/ref/path/to/skill/SKILL.md
  const nested = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)\/SKILL\.md$/);
  if (nested) return { owner: nested[1]!, repo: nested[2]!, ref: nested[3]!, dir: nested[4]! };
  // Root-level skill: owner/repo/ref/SKILL.md (no subdirectory)
  const root = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/SKILL\.md$/);
  if (root) return { owner: root[1]!, repo: root[2]!, ref: root[3]!, dir: "" };
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

  // Bare repo URL: https://github.com/owner/repo or https://github.com/owner/repo/
  // HEAD is the git symbolic ref for the default branch — more reliable than
  // hardcoding "main" since repos may use "master" or another default.
  const repo = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (repo) return `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/SKILL.md`;

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

/**
 * When a raw GitHub URL 404s, check whether the path is actually a directory
 * containing multiple skill subdirectories. Returns the list of subdirectory
 * names if found, or undefined to fall through to the generic error.
 */
async function listGitHubSkillSubdirs(
  github: { owner: string; repo: string; ref: string; dir: string },
): Promise<{ subdirs: string[] } | { apiError: number } | undefined> {
  const apiPath = github.dir || ".";
  const api = `https://api.github.com/repos/${github.owner}/${github.repo}/contents/${apiPath}?ref=${encodeURIComponent(github.ref)}`;
  let res: Response;
  try {
    res = await fetch(api, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "agav-cli" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return undefined;
  }
  if (!res) return undefined;
  if (!res.ok) return { apiError: res.status };

  let entries: GitHubEntry[];
  try {
    entries = (await res.json()) as GitHubEntry[];
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;

  const subdirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
  return subdirs.length > 0 ? { subdirs } : undefined;
}

/** Result type for single-skill installs. */
export type InstallResult =
  | { name: string; warnings: string[] }
  | { names: string[]; warnings: string[]; failed: string[] }
  | { error: string };

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
    let res: Response;
    try {
      res = await fetch(api, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: "application/vnd.github.v3+json" },
      });
    } catch (err) {
      warnings.push(`Could not list ${apiPath} (${describeNetworkError(err)}) — its files were not installed.`);
      return;
    }
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

      let fileRes: Response;
      try {
        fileRes = await fetch(entry.download_url, { signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        warnings.push(`Could not download ${entry.path} (${describeNetworkError(err)}).`);
        continue;
      }
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

export async function installFromUrl(url: string): Promise<InstallResult> {
  try {
    const target = normaliseSkillUrl(url);

    let res: Response;
    try {
      res = await fetch(target, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      return { error: `Failed to fetch SKILL.md: ${describeNetworkError(err)}` };
    }
    if (!res.ok) {
      // When a GitHub raw URL 404s, the user may have pointed at a directory
      // containing multiple skill subdirectories. Detect this and install
      // all of them in one go.
      if (res.status === 404) {
        const github = parseGitHubSkillUrl(target);
        if (github) {
          const listing = await listGitHubSkillSubdirs(github);
          if (listing && "subdirs" in listing) {
            return await installMultipleFromGitHub(github, listing.subdirs);
          }
          if (listing && "apiError" in listing) {
            return {
              error:
                `No SKILL.md found at this URL. It may be a directory containing multiple skills, ` +
                `but the GitHub API returned HTTP ${listing.apiError} (${listing.apiError === 403 ? "rate-limited — try again later or use a GitHub token" : "error"}) ` +
                `when listing its contents.`,
            };
          }
        }
      }
      return { error: `Failed to fetch SKILL.md: HTTP ${res.status}` };
    }
    const markdown = await res.text();

    // Catch HTML pages served by browser-facing URLs that slipped past normalisation.
    const trimmed = markdown.trimStart().slice(0, 50).toLowerCase();
    if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.includes("<head>")) {
      return { error: `The URL returned an HTML page, not a SKILL.md file. Use a raw/direct link to the SKILL.md file (e.g. a raw.githubusercontent.com URL).` };
    }

    const github = parseGitHubSkillUrl(target);
    const { passed, warnings } = validateSkill(markdown, {
      dirName: github?.dir ? basename(github.dir) : undefined,
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

/**
 * Install every skill subdirectory from a GitHub parent directory.
 * Each subdirectory is installed independently — failures in one skill
 * do not block the others.
 */
async function installMultipleFromGitHub(
  parent: { owner: string; repo: string; ref: string; dir: string },
  subdirs: string[],
): Promise<InstallResult> {
  const names: string[] = [];
  const failed: string[] = [];
  const warnings: string[] = [];

  for (const subdir of subdirs) {
    const skillDir = parent.dir ? `${parent.dir}/${subdir}` : subdir;
    const rawUrl = `https://raw.githubusercontent.com/${parent.owner}/${parent.repo}/${parent.ref}/${skillDir}/SKILL.md`;

    const result = await installFromUrl(rawUrl);
    if ("error" in result) {
      failed.push(subdir);
      warnings.push(`${subdir}: ${result.error}`);
    } else if ("names" in result) {
      // Shouldn't happen (nested batch), but handle gracefully
      names.push(...result.names);
      failed.push(...result.failed);
      warnings.push(...result.warnings);
    } else {
      names.push(result.name);
      warnings.push(...result.warnings);
    }
  }

  if (names.length === 0) {
    return { error: `None of the ${subdirs.length} skills could be installed:\n${warnings.join("\n")}` };
  }

  return { names, warnings, failed };
}

export async function installFromPath(sourcePath: string): Promise<InstallResult> {
  try {
    const info = await stat(sourcePath).catch(() => undefined);
    if (!info) return { error: `No such file or directory: ${sourcePath}` };

    // Naming the directory means "install this skill" and takes the whole tree.
    // Naming a SKILL.md takes only the directories the spec reserves, since the
    // file may well be sitting in a downloads folder full of unrelated things.
    const isDir = info.isDirectory();
    const srcDir = isDir ? sourcePath : dirname(sourcePath);
    const resolvedSrcDir = resolve(srcDir);
    const mdPath = isDir ? join(sourcePath, "SKILL.md") : sourcePath;

    // When the .md file is a bare filename (e.g. "subagent.md"), dirname
    // returns "." which resolves to the CWD.  The file is standalone — not
    // inside a dedicated skill directory — so we must NOT scan the CWD for
    // sibling asset directories (scripts/, references/, assets/) that would
    // be completely unrelated.
    const isBareFile = !isDir && resolvedSrcDir === resolve(process.cwd());

    // For directories: check if this is a parent containing multiple skills.
    // If so, install all of them instead of refusing.
    if (isDir) {
      const nestedSkills: string[] = [];
      const topEntries = await readdir(srcDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        try {
          await stat(join(srcDir, entry.name, "SKILL.md"));
          nestedSkills.push(entry.name);
        } catch { /* no SKILL.md in this subdir — fine */ }
      }
      if (nestedSkills.length > 0) {
        // Check whether the parent itself also has a SKILL.md. If it does,
        // it's a single skill whose subdirectories happen to contain their
        // own SKILL.md — don't treat it as a batch install.
        const parentHasSkill = await readFile(join(srcDir, "SKILL.md"), "utf-8").catch(() => undefined);
        if (!parentHasSkill) {
          return await installMultipleFromPath(sourcePath, nestedSkills);
        }
      }
    }

    const markdown = await readFile(mdPath, "utf-8").catch(() => undefined);
    if (markdown === undefined) {
      return { error: isDir ? `No SKILL.md in ${sourcePath}` : `Could not read ${sourcePath}` };
    }

    const { passed, warnings } = validateSkill(markdown, { dirName: isBareFile ? undefined : basename(srcDir) });
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
      // Only scan for sibling asset directories when the .md file lives
      // inside a proper skill directory.  A bare file in the CWD should
      // not cause unrelated directories to be copied.
      if (!isBareFile) {
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
    }

    return { name, warnings };
  } catch (err) {
    return { error: `Install failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Install every skill subdirectory from a local parent directory.
 * Each subdirectory is installed independently — failures in one skill
 * do not block the others.
 */
async function installMultipleFromPath(
  parentPath: string,
  subdirs: string[],
): Promise<InstallResult> {
  const names: string[] = [];
  const failed: string[] = [];
  const warnings: string[] = [];

  for (const subdir of subdirs) {
    const result = await installFromPath(join(parentPath, subdir));
    if ("error" in result) {
      failed.push(subdir);
      warnings.push(`${subdir}: ${result.error}`);
    } else if ("names" in result) {
      names.push(...result.names);
      failed.push(...result.failed);
      warnings.push(...result.warnings);
    } else {
      names.push(result.name);
      warnings.push(...result.warnings);
    }
  }

  if (names.length === 0) {
    return { error: `None of the ${subdirs.length} skills could be installed:\n${warnings.join("\n")}` };
  }

  return { names, warnings, failed };
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

/**
 * Remove all user-installed (non-bundled) skills from the global skills
 * directory. Bundled skills are compiled into the binary and are unaffected.
 * Project-local skills (under .agav/skills/) are also left alone — they
 * belong to the project, not the user's global config.
 *
 * @returns Names of the skills that were removed.
 */
export async function clearSkills(): Promise<string[]> {
  const skillsDir = join(getAgavDir(), "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return []; // Directory doesn't exist or isn't readable — nothing to clear
  }

  const removed: string[] = [];
  const { rm } = await import("node:fs/promises");
  for (const entry of entries) {
    const full = join(skillsDir, entry);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;
    try {
      await rm(full, { recursive: true, force: true });
      removed.push(entry);
    } catch { /* best effort */ }
  }
  return removed;
}
