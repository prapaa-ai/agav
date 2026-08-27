/**
 * Shared helpers used by the skill subsystem. Centralised here so that the slug
 * a skill is installed under is always derived the same way, and tool-name
 * stripping is consistent between validation and runtime.
 */

/** Derive a URL/directory-safe slug from a skill name. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Strip the agentskills.io qualifier from a tool entry: `Bash(git:*)` → `Bash`.
 * agav gates whole tools, so the qualifier is informational only.
 */
export function baseToolName(entry: string): string {
  const paren = entry.indexOf("(");
  return (paren < 0 ? entry : entry.slice(0, paren)).trim();
}
