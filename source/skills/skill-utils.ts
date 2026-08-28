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
 * Mapping from agentskills.io spec tool names to agav runtime tool names.
 * Used by `baseToolName` so that skills authored with spec-style names
 * (e.g. `Bash`, `Read`) resolve correctly at runtime, and by `validate.ts`
 * to produce "did you mean?" warnings.
 */
export const SPEC_TOOL_ALIASES: Readonly<Record<string, string>> = {
  Bash: "run_command",
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  MultiEdit: "edit_file",
  Grep: "grep_search",
  Glob: "find_files",
  LS: "list_directory",
  WebSearch: "web_search",
  WebFetch: "fetch_url",
  NotebookRead: "read_notebook",
  NotebookEdit: "edit_notebook",
  TodoRead: "update_plan",
  TodoWrite: "update_plan",
};

/**
 * Strip the agentskills.io qualifier from a tool entry and resolve spec aliases
 * to agav runtime names: `Bash(git:*)` → `run_command`, `Read` → `read_file`.
 * Names that are already agav-native pass through unchanged.
 */
export function baseToolName(entry: string): string {
  const paren = entry.indexOf("(");
  const name = (paren < 0 ? entry : entry.slice(0, paren)).trim();
  return SPEC_TOOL_ALIASES[name] ?? name;
}
