import type { ToolDefinition, ToolResult } from "../tools/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ConfirmResult } from "../agent/loop.js";
import type { PermissionMode, EffortLevel } from "../config/config.js";
import { getSkill } from "./loader.js";
import { executeSkill } from "./executor.js";

interface SkillToolDeps {
  provider: LLMProvider;
  parentRegistry: ToolRegistry;
  getConfig: () => {
    model: string;
    systemPrompt: string;
    permissionMode: PermissionMode;
    effort: EffortLevel;
    maxIterations: number;
  };
  confirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  getSignal: () => AbortSignal | undefined;
}

export function createSkillTool(deps: SkillToolDeps): ToolDefinition {
  return {
    schema: {
      name: "activate_skill",
      description:
        "Activate and run a skill by name. Use this when a task matches an available skill. " +
        "The skill runs in an isolated context with its own tools and instructions.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name to activate (from the available skills catalog)",
          },
          arguments: {
            type: "string",
            description: "Arguments or context to pass to the skill",
          },
        },
        required: ["name"],
      },
    },

    async execute(input): Promise<ToolResult> {
      const name = String(input.name);
      const args = String(input.arguments ?? "");
      const skill = getSkill(name);

      if (!skill) {
        return { output: `Skill "${name}" not found. Use /skills to list available skills.`, isError: true };
      }

      if (skill.frontmatter.invocation === "user") {
        return { output: `Skill "${name}" is user-only — it can only be invoked via /${skill.slug}.`, isError: true };
      }

      try {
        const config = deps.getConfig();
        const result = await executeSkill(skill, args, {
          provider: deps.provider,
          parentRegistry: deps.parentRegistry,
          model: config.model,
          systemPrompt: config.systemPrompt,
          permissionMode: config.permissionMode,
          effort: config.effort,
          maxIterations: config.maxIterations,
          confirmTool: deps.confirmTool,
          onTokenUsage: deps.onTokenUsage,
          signal: deps.getSignal(),
        });
        return { output: result.output, isError: false };
      } catch (err) {
        return {
          output: `Skill "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
