import type { EffortLevel } from "../config/config.js";

export interface SkillFrontmatter {
  // --- agentskills.io spec fields ---
  name: string;
  description: string;
  /** License name, or the name of a license file bundled with the skill. */
  license?: string;
  /** Environment requirements: intended product, system packages, network access. */
  compatibility?: string;
  /**
   * Arbitrary string map the spec reserves for client-specific properties.
   * agav reads its own fields from here as a fallback when they are absent at
   * the top level, so a skill written the spec's way behaves the same either way.
   */
  metadata?: Record<string, string>;
  /**
   * The spec writes this as a space-separated string (`Bash(git:*) Read`); agav's
   * own skills write a YAML list. The parser normalises both to an array.
   */
  "allowed-tools"?: string[];

  // --- agav extensions (spec-compliant skills may nest these under metadata) ---
  version?: string;
  invocation?: "user" | "agav" | "both";
  "disallowed-tools"?: string[];
  model?: string;
  effort?: EffortLevel;
  tags?: string[];
}

export interface SkillDefinition {
  name: string;
  slug: string;
  description: string;
  body: string;
  frontmatter: SkillFrontmatter;
  filePath: string;
  origin: "bundled" | "global" | "project";
  /** When a project/global skill overrides one from a higher-trust tier. */
  overriddenOrigin?: "bundled" | "global";
  /**
   * True when the user turned this skill off via the skill registry. Disabled
   * skills are excluded from the catalog and slash commands but still listed by
   * `/skills` so they can be re-enabled.
   */
  disabled?: boolean;
}
