import { parseSkillMarkdown } from "./loader.js";

const DANGER_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+all\s+prior/i,
  /disregard\s+(all\s+)?previous/i,
  /curl\s+.*\|\s*sh/,
  /wget\s+.*\|\s*(bash|sh)/,
  /\beval\s*\(/,
  /rm\s+-rf\s+\//,
  /chmod\s+777/,
  /base64\s+.*\|\s*(bash|sh)/,
];

const VALID_INVOCATIONS = new Set(["user", "agav", "both"]);
const MAX_SIZE = 64 * 1024;

// agentskills.io field limits.
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_COMPATIBILITY = 500;
const SPEC_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ValidateOptions {
  /**
   * Name of the directory the SKILL.md sits in. The spec requires `name` to
   * match it; supply it where that is knowable (a local or GitHub install) so
   * the check can run.
   */
  dirName?: string;
}

/**
 * Blocking failures are the ones that leave a skill unusable: absent required
 * fields, values past the spec's hard limits, or a prompt-injection pattern in
 * the body. Naming violations come back as warnings instead — agav slugifies the
 * name to derive a directory and slash command, so such a skill still runs, and
 * refusing it would reject skills that work fine everywhere else today.
 */
export function validateSkill(markdown: string, options: ValidateOptions = {}): { passed: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const { frontmatter, body } = parseSkillMarkdown(markdown);
  const name = frontmatter.name === "unknown" ? "" : frontmatter.name;

  if (!name) {
    warnings.push("Missing required field: name");
  } else {
    if (name.length > MAX_NAME) {
      warnings.push(`Invalid name: ${name.length} characters (spec allows at most ${MAX_NAME})`);
    }
    if (!SPEC_NAME.test(name)) {
      warnings.push(
        `Non-conforming name: "${name}" — the spec allows lowercase letters, numbers and single ` +
          `hyphens only, and no leading or trailing hyphen. agav will use "${slugify(name)}" instead.`,
      );
    }
    if (options.dirName && name !== options.dirName) {
      warnings.push(`Non-conforming name: "${name}" does not match its directory "${options.dirName}".`);
    }
  }

  if (!frontmatter.description) {
    warnings.push("Missing required field: description");
  } else if (frontmatter.description.length > MAX_DESCRIPTION) {
    warnings.push(
      `Invalid description: ${frontmatter.description.length} characters (spec allows at most ${MAX_DESCRIPTION})`,
    );
  }

  if (frontmatter.compatibility && frontmatter.compatibility.length > MAX_COMPATIBILITY) {
    warnings.push(
      `Non-conforming compatibility: ${frontmatter.compatibility.length} characters (spec allows at most ${MAX_COMPATIBILITY})`,
    );
  }

  if (frontmatter.invocation && !VALID_INVOCATIONS.has(frontmatter.invocation)) {
    warnings.push(`Invalid invocation: "${frontmatter.invocation}" (must be user, agav, or both)`);
  }
  if (markdown.length > MAX_SIZE) {
    warnings.push(`Skill file exceeds 64KB (${Math.round(markdown.length / 1024)}KB)`);
  }

  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(body)) {
      warnings.push(`Dangerous pattern detected: ${pattern.source}`);
    }
  }

  const passed = !warnings.some(
    (w) => w.startsWith("Missing required") || w.startsWith("Dangerous") || w.startsWith("Invalid name") || w.startsWith("Invalid description"),
  );
  return { passed, warnings };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
