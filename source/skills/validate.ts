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

export function validateSkill(markdown: string): { passed: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const { frontmatter, body } = parseSkillMarkdown(markdown);

  if (!frontmatter.name || frontmatter.name === "unknown") {
    warnings.push("Missing required field: name");
  }
  if (!frontmatter.description) {
    warnings.push("Missing required field: description");
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

  const passed = !warnings.some((w) => w.startsWith("Missing required") || w.startsWith("Dangerous"));
  return { passed, warnings };
}
