import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgavDir } from "../config/config.js";
import { BUNDLED_SKILL_FILES } from "./bundled-manifest.js";
import { validateSkill } from "./validate.js";
import type { SkillFrontmatter, SkillDefinition } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedSkills: SkillDefinition[] | null = null;

function unquote(val: string): string {
  if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
    return val.slice(1, -1);
  }
  return val;
}

function parseScalar(raw: string): string | boolean | string[] {
  const val = raw.trim();
  if (val === "true") return true;
  if (val === "false") return false;
  if (val.startsWith("[") && val.endsWith("]")) {
    return val.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
  }
  return unquote(val);
}

/**
 * Indentation-aware YAML subset: scalars, block/flow sequences, and nested maps.
 *
 * The nesting matters for spec conformance. agentskills.io puts client-specific
 * fields under a `metadata:` map, and a flat line-by-line parse hoists those
 * children to the top level — where a skill's `metadata.version` would quietly
 * take over agav's own `version` field.
 */
function parseYamlBlock(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ")) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const key = line.slice(0, colonIdx).trim();
    const inline = line.slice(colonIdx + 1).trim();
    i++;

    if (inline !== "") {
      out[key] = parseScalar(inline);
      continue;
    }

    // Bare `key:` — everything indented further than it belongs to this key.
    const block: string[] = [];
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim()) {
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
      }
      block.push(next);
      i++;
    }

    const items = block.filter((l) => l.trim().startsWith("- "));
    if (items.length > 0) {
      out[key] = items.map((l) => unquote(l.trim().slice(2).trim()));
    } else if (block.some((l) => l.trim())) {
      out[key] = parseYamlBlock(block);
    } else {
      out[key] = [];
    }
  }

  return out;
}

/**
 * Splits a space-separated tool list without breaking up parenthesised
 * qualifiers, so `Bash(npm run test:*) Read` yields two entries rather than four.
 */
function splitToolList(val: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of val) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === " " || ch === "\t" || ch === ",")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The spec spells tool permissions as one space-separated string; agav's own
 * skills spell them as a YAML list. Everything downstream treats the field as an
 * array — `/skills info` joins it — so normalise here rather than at each caller.
 */
function toStringList(val: unknown): string[] | undefined {
  if (Array.isArray(val)) {
    const items = val.map((v) => String(v).trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof val === "string") {
    const items = splitToolList(val);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

/** A `metadata:` map, per the spec: string keys to string values. */
function toStringMap(val: unknown): Record<string, string> | undefined {
  if (!val || typeof val !== "object" || Array.isArray(val)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (v === null || typeof v === "object") continue;
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseSkillMarkdown(text: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: { name: "unknown", description: "" }, body: text };
  }

  const fm = parseYamlBlock(match[1]!.split("\n"));
  const body = match[2]!.trim();

  // agav's extensions sit at the top level, but the spec tells authors to put
  // anything it doesn't define under `metadata`. Accept both spellings, with the
  // top level winning so an author can override what a shared metadata block says.
  const metadata = toStringMap(fm.metadata);
  const pick = (key: string): unknown => fm[key] ?? metadata?.[key];
  const str = (key: string): string | undefined => {
    const v = pick(key);
    return v === undefined || v === "" ? undefined : String(v);
  };

  return {
    frontmatter: {
      name: String(fm.name ?? "unknown"),
      description: String(fm.description ?? ""),
      license: str("license"),
      compatibility: str("compatibility"),
      metadata,
      "allowed-tools": toStringList(pick("allowed-tools")),
      version: str("version"),
      invocation: (str("invocation") as SkillFrontmatter["invocation"]) ?? "both",
      "disallowed-tools": toStringList(pick("disallowed-tools")),
      model: str("model"),
      effort: str("effort") as SkillFrontmatter["effort"],
      tags: toStringList(pick("tags")),
    },
    body,
  };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The bundled tier comes from strings compiled into the program, not from disk.
 * A compiled binary resolves `import.meta.url` to `file:///$bunfs/root/…`, so a
 * path built from it finds nothing however the .md files were copied.
 */
function loadBundled(): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  for (const [dir, text] of Object.entries(BUNDLED_SKILL_FILES)) {
    const { frontmatter, body } = parseSkillMarkdown(text);
    skills.push({
      name: frontmatter.name,
      slug: slugify(frontmatter.name),
      description: frontmatter.description,
      body,
      frontmatter,
      // Where the skill came from, for `/skills info`. Only resolves in a
      // source checkout — the contents above are what actually gets used.
      filePath: join(__dirname, "bundled", dir, "SKILL.md"),
      origin: "bundled",
    });
  }
  return skills;
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
        const { passed, warnings } = validateSkill(text, { dirName: entry.name });
        if (!passed) {
          if (warnings.length > 0) {
            console.error(`[skills] skipping ${skillPath}: ${warnings.join("; ")}`);
          }
          continue;
        }
        if (warnings.length > 0) {
          console.warn(`[skills] ${skillPath}: ${warnings.join("; ")}`);
        }
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
  // slug → filePath of the winner, so collision warnings can name both files.
  const seen = new Map<string, string>();

  for (const s of loadBundled()) {
    if (!seen.has(s.slug)) { seen.set(s.slug, s.filePath); skills.push(s); }
  }

  const globalDir = join(getAgavDir(), "skills");
  for (const s of await scanDir(globalDir, "global")) {
    if (seen.has(s.slug)) {
      console.warn(`[skills] duplicate slug "${s.slug}": "${s.filePath}" skipped (kept "${seen.get(s.slug)}")`);
    } else {
      seen.set(s.slug, s.filePath);
      skills.push(s);
    }
  }

  // Project skills intentionally override bundled/global (higher-trust) skills;
  // the override is recorded and warned separately from same-tier collisions.
  const projectDir = join(process.cwd(), ".agav", "skills");
  for (const s of await scanDir(projectDir, "project")) {
    if (seen.has(s.slug)) {
      const idx = skills.findIndex((x) => x.slug === s.slug);
      if (idx >= 0) {
        const existing = skills[idx]!;
        if (existing.origin === "project") {
          // Same-tier collision within the project dir — skip the duplicate.
          console.warn(`[skills] duplicate slug "${s.slug}": "${s.filePath}" skipped (kept "${seen.get(s.slug)}")`);
          continue;
        }
        s.overriddenOrigin = existing.origin as "bundled" | "global";
        console.warn(`[skills] project skill "${s.slug}" overrides ${existing.origin} skill`);
        skills[idx] = s;
        seen.set(s.slug, s.filePath);
      }
    } else {
      seen.set(s.slug, s.filePath);
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
