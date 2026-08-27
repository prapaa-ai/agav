import type { SlashCommand, CommandResult, CommandContext } from "../commands/types.js";
import type { SkillDefinition } from "./types.js";
import { loadSkills, getSkill } from "./loader.js";
import { executeSkill } from "./executor.js";
import { installFromUrl, installFromPath, removeSkill, fetchMarketplaceIndex } from "./marketplace.js";
import { getSkillTraces } from "./improvement.js";
import { agavHomePath } from "../utils/shell-hints.js";

export function createSkillSlashCommand(skill: SkillDefinition): SlashCommand {
  return {
    name: skill.slug,
    description: skill.description,
    async execute(args: string, context: CommandContext): Promise<CommandResult> {
      if (skill.frontmatter.invocation === "user") {
        if (!context.provider) {
          return { type: "message", text: "No provider configured." };
        }
        context.setRunningSkill(skill.name);
        try {
          const result = await executeSkill(skill, args.trim(), {
            provider: context.provider,
            parentRegistry: context.toolRegistry,
            model: context.config.model,
            systemPrompt: context.config.systemPrompt ?? "",
            permissionMode: context.config.permissionMode,
            effort: context.config.effort,
            maxIterations: context.config.maxIterations,
          });
          return { type: "message", text: result.output, _tokenUsage: result.tokenUsage, _isSkill: true } as any;
        } catch (err) {
          return {
            type: "message",
            text: `Skill "${skill.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      const prompt = args.trim()
        ? `[skill:${skill.name}] ${args.trim()}`
        : `[skill:${skill.name}]`;
      return { type: "submit", text: prompt };
    },
  };
}

export const skillsCommand: SlashCommand = {
  name: "skills",
  description: "Manage skills",
  // agavHomePath rather than a literal "~/.agav/skills": on PowerShell and cmd
  // that spelling is neither typeable nor recognisable.
  usage: `Usage: /skills [action]\n\n  /skills                 List installed skills\n  /skills list            Same as above\n  /skills add <url|path>  Install from a URL or a local skill directory\n  /skills remove <name>   Uninstall a skill\n  /skills info <name>     Show details about a skill\n  /skills marketplace     Browse available skills\n\nA skill is a directory holding a SKILL.md with YAML frontmatter, plus\noptional scripts/, references/ and assets/. The agent can activate one\nautomatically or you can invoke it as a slash command.\n\nInstalls are written to ${agavHomePath("skills")} and take effect after a\nrestart. Point a path at the skill directory to install all of it, or at a\nlone SKILL.md to take just that file and any scripts/, references/ or\nassets/ beside it. GitHub URLs install the whole directory; other hosts\noffer no listing, so only the SKILL.md itself is fetched.`,
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase() || "list";

    if (action === "list" || !args.trim()) {
      const skills = await loadSkills();
      if (skills.length === 0) {
        return { type: "message", text: "No skills installed. Use /skills add <url|path> or /skills marketplace." };
      }
      const lines = skills.map((s) => {
        const inv = s.frontmatter.invocation ?? "both";
        const label = inv === "both" ? "auto+manual" : inv === "agav" ? "auto" : "manual";
        let origin = s.origin === "bundled" ? " (bundled)" : s.origin === "project" ? " (project)" : "";
        if (s.overriddenOrigin) origin = ` (project, overrides ${s.overriddenOrigin})`;
        return `  /${s.slug.padEnd(18)} ${s.description.slice(0, 50).padEnd(50)} [${label}]${origin}`;
      });
      return { type: "message", text: "Installed skills:\n" + lines.join("\n") };
    }

    if (action === "add") {
      const source = parts.slice(1).join(" ").trim();
      if (!source) {
        return { type: "message", text: "Usage: /skills add <url|path>" };
      }
      context.showStatus(`Installing skill from ${source.startsWith("http") ? "URL" : "path"}…`);
      const result = source.startsWith("http")
        ? await installFromUrl(source)
        : await installFromPath(source);

      if ("error" in result) {
        return { type: "message", text: result.error };
      }
      const warns = result.warnings.length > 0 ? `\nWarnings:\n${result.warnings.join("\n")}` : "";
      return { type: "message", text: `Installed skill: ${result.name}${warns}\nRestart to activate.` };
    }

    if (action === "remove" || action === "rm") {
      const name = parts.slice(1).join(" ").trim();
      if (!name) return { type: "message", text: "Usage: /skills remove <name>" };
      const removed = await removeSkill(name);
      return { type: "message", text: removed ? `Removed skill: ${name}. Restart to take effect.` : `Skill "${name}" not found.` };
    }

    if (action === "info") {
      const name = parts.slice(1).join(" ").trim();
      if (!name) return { type: "message", text: "Usage: /skills info <name>" };
      const skill = getSkill(name);
      if (!skill) return { type: "message", text: `Skill "${name}" not found.` };
      const traces = await getSkillTraces(skill.name);
      const totalTokens = traces.reduce((sum, t) => sum + t.tokensUsed, 0);
      const avgTokens = traces.length > 0 ? Math.round(totalTokens / traces.length) : 0;
      const successRate = traces.length > 0
        ? Math.round(traces.filter((t) => t.success !== false).length / traces.length * 100)
        : 0;
      const fm = skill.frontmatter;
      const lines = [
        `Name: ${skill.name}`,
        `Description: ${skill.description}`,
        `Version: ${fm.version ?? "unversioned"}`,
        `Invocation: ${fm.invocation ?? "both"}`,
        `Origin: ${skill.origin}${skill.overriddenOrigin ? ` (overrides ${skill.overriddenOrigin})` : ""}`,
        `Tags: ${fm.tags?.join(", ") ?? "none"}`,
        `Allowed tools: ${fm["allowed-tools"]?.join(", ") ?? "all"}`,
        `Disallowed tools: ${fm["disallowed-tools"]?.join(", ") ?? "none"}`,
      ];
      // Spec fields, shown only when the author set them — most skills do not.
      if (fm.license) lines.push(`License: ${fm.license}`);
      if (fm.compatibility) lines.push(`Compatibility: ${fm.compatibility}`);
      if (fm.metadata) {
        const extra = Object.entries(fm.metadata).map(([k, v]) => `${k}=${v}`);
        if (extra.length > 0) lines.push(`Metadata: ${extra.join(", ")}`);
      }
      lines.push(
        `Usage: ${traces.length} runs · ${avgTokens} avg tokens · ${successRate}% success`,
        `Path: ${skill.filePath}`,
      );
      return { type: "message", text: lines.join("\n") };
    }

    if (action === "marketplace") {
      const num = parts[1] ? parseInt(parts[1], 10) : NaN;
      context.showStatus("Fetching skill marketplace…");
      const index = await fetchMarketplaceIndex();

      if (!isNaN(num) && num >= 1 && num <= index.length) {
        const pick = index[num - 1]!;
        if (!pick.url) return { type: "message", text: `No install URL for "${pick.name}".` };
        context.showStatus(`Installing "${pick.name}" from marketplace…`);
        const result = await installFromUrl(pick.url);
        if ("error" in result) return { type: "message", text: result.error };
        const warns = result.warnings.length > 0 ? `\nWarnings:\n${result.warnings.join("\n")}` : "";
        return { type: "message", text: `Installed skill: ${result.name}${warns}\nRestart to activate.` };
      }

      const lines = index.map((s, i) =>
        `  ${String(i + 1).padStart(2)}. ${s.name}`,
      );
      return {
        type: "message",
        text: "Skill Marketplace (anthropics/skills):\n" + lines.join("\n") +
          "\n\nInstall: /skills marketplace <number>",
      };
    }

    return { type: "message", text: "Unknown action. Usage: /skills [list|add|remove|info|marketplace]" };
  },
};
