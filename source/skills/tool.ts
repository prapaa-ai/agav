import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent, ConfirmResult, ConfirmToolFn } from "../agent/loop.js";
import type { PermissionMode, EffortLevel, AgavConfig } from "../config/config.js";
import { getSkill } from "./loader.js";
import { executeSkill } from "./executor.js";

interface SkillToolDeps {
  provider: LLMProvider;
  parentRegistry: ToolRegistry;
  getConfig: () => {
    model: string;
    systemPrompt: string;
    permissionMode: PermissionMode;
    /** Original background consent mode, independent of generic Always. */
    backgroundPermissionMode?: PermissionMode;
    effort: EffortLevel;
    iterationsBudget: { remaining: number, total: number };
    providerIdleTimeout?: number;
  };
  /** Full parent config for deriving the org selection/permission policy. */
  getProviderConfig?: () => AgavConfig;
  confirmTool?: (...args: [...Parameters<ConfirmToolFn>, signal?: AbortSignal]) => Promise<ConfirmResult>;
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
  getSignal: () => AbortSignal | undefined;
  createProgressTracker?: (title: string, task: string, id: string) => (event: AgentEvent) => void;
}

export function createSkillTool(deps: SkillToolDeps): ToolDefinition & { cancelSkill(id: string): void } {
  const controllers = new Map<string, AbortController>();
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

    async execute(input, context): Promise<ToolResult> {
      const name = String(input.name);
      const args = String(input.arguments ?? "");
      const skill = getSkill(name);

      if (!skill) {
        return { output: `Skill "${name}" not found. Use /skills to list available skills.`, isError: true };
      }

      if (skill.frontmatter.invocation === "user") {
        return { output: `Skill "${name}" is user-only — it can only be invoked via /${skill.slug}.`, isError: true };
      }

      const id = `skill-${randomUUID()}`;
      const controller = new AbortController();
      const parentSignal = context?.signal ?? deps.getSignal();
      const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
      controllers.set(id, controller);
      try {
        const config = deps.getConfig();
        const providerConfig = deps.getProviderConfig?.();
        const result = await executeSkill(skill, args, {
          provider: deps.provider,
          parentRegistry: deps.parentRegistry,
          model: config.model,
          systemPrompt: context?.systemPrompt ?? config.systemPrompt,
          permissionMode: context?.permissionMode ?? config.permissionMode,
          backgroundPermissionMode: config.backgroundPermissionMode,
          contextMessages: context?.conversation,
          effort: config.effort,
          iterationsBudget: config.iterationsBudget,
          providerIdleTimeout: config.providerIdleTimeout,
          policy: providerConfig ? {
            provider: providerConfig.provider,
            orgPermissionFloor: providerConfig.orgPermissionFloor,
            orgManagedModel: providerConfig.orgManagedModel,
            orgAllowedModels: providerConfig.orgAllowedModels,
            orgManagedProvider: providerConfig.orgManagedProvider,
            orgAllowedProviders: providerConfig.orgAllowedProviders,
          } : undefined,
          confirmTool: deps.confirmTool ? (...[toolName, input, diffLines, mcpServerName, warning]: Parameters<ConfirmToolFn>) =>
            deps.confirmTool!(toolName, input, diffLines, mcpServerName, warning, signal) : undefined,
          onTokenUsage: deps.onTokenUsage,
          signal,
          onEvent: deps.createProgressTracker?.(`Skill: ${skill.name}`, args || skill.description, id),
        });
        return { output: result.output, isError: false };
      } catch (err) {
        return {
          output: `Skill "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      } finally {
        controllers.delete(id);
      }
    },

    cancelSkill(id: string) {
      controllers.get(id)?.abort();
    },
  };
}
