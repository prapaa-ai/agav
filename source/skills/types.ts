import type { EffortLevel } from "../config/config.js";

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  invocation?: "user" | "agav" | "both";
  "allowed-tools"?: string[];
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
}
