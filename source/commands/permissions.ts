import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { PermissionManager, type PermissionAction } from "../config/permissions.js";

export const permissionsCommand: SlashCommand = {
  name: "permissions",
  description: "View and manage granular tool permission policies (.agav/permissions.json)",
  usage:
    "Usage: /permissions [allow <rule> | deny <rule> | ask <rule> | remove <rule> | clear]\n\n" +
    "  /permissions                     List active project and global permission rules\n" +
    "  /permissions allow <rule>        Allow tool or command without confirmation prompt\n" +
    "  /permissions deny <rule>         Unconditionally block tool or command pattern\n" +
    "  /permissions ask <rule>          Require user confirmation before executing\n" +
    "  /permissions remove <rule>       Remove a rule from .agav/permissions.json\n" +
    "  /permissions clear               Clear all project permission rules\n\n" +
    "Examples:\n" +
    "  /permissions allow run_command:pnpm test*\n" +
    "  /permissions allow write_file:src/*\n" +
    "  /permissions deny write_file:.env*\n" +
    "  /permissions ask run_command:*",

  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const cwd = context.toolRegistry?.getDefaultContext()?.cwd ?? process.cwd();
    const manager = await PermissionManager.load(cwd);
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    if (!sub || sub === "list") {
      const rules = manager.getRules();
      if (rules.length === 0) {
        return {
          type: "message",
          text: [
            "No custom permission rules configured.",
            "Default behavior: Built-in safe tools execute without prompts; destructive and modifying tools ask for confirmation.",
            "",
            "To grant or deny permissions:",
            "  /permissions allow run_command:pnpm test*",
            "  /permissions deny write_file:.env*",
            "  /permissions ask run_command:*",
          ].join("\n"),
        };
      }

      const projectRules = rules.filter((r) => r.source === "project");
      const globalRules = rules.filter((r) => r.source === "global");

      const lines: string[] = ["Active Tool Permission Policies:"];

      if (projectRules.length > 0) {
        lines.push("\n[Project Rules] (.agav/permissions.json):");
        for (const r of projectRules) {
          lines.push(`  ${r.action.toUpperCase().padEnd(6)} ${r.pattern}`);
        }
      }

      if (globalRules.length > 0) {
        lines.push("\n[Global Rules] (~/.agav/permissions.json):");
        for (const r of globalRules) {
          lines.push(`  ${r.action.toUpperCase().padEnd(6)} ${r.pattern}`);
        }
      }

      return { type: "message", text: lines.join("\n") };
    }

    if (sub === "allow" || sub === "deny" || sub === "ask") {
      const pattern = parts.slice(1).join(" ").trim();
      if (!pattern) {
        return {
          type: "message",
          text: `Missing rule pattern. Usage: /permissions ${sub} <tool:pattern>`,
        };
      }

      await manager.addRule(pattern, sub as PermissionAction, "project");
      return {
        type: "message",
        text: `✓ Set permission rule in .agav/permissions.json:\n  [${sub.toUpperCase()}] ${pattern}`,
      };
    }

    if (sub === "remove" || sub === "delete") {
      const pattern = parts.slice(1).join(" ").trim();
      if (!pattern) {
        return {
          type: "message",
          text: "Missing rule pattern to remove. Usage: /permissions remove <tool:pattern>",
        };
      }

      const removed = await manager.removeRule(pattern, "project");
      if (removed) {
        return {
          type: "message",
          text: `✓ Removed rule from .agav/permissions.json: ${pattern}`,
        };
      } else {
        return {
          type: "message",
          text: `Rule '${pattern}' not found in project permissions.`,
        };
      }
    }

    if (sub === "clear") {
      await manager.clearRules("project");
      return {
        type: "message",
        text: "✓ Cleared all project permission rules from .agav/permissions.json.",
      };
    }

    return {
      type: "message",
      text: `Unknown permissions command '${sub}'. Type /permissions for usage.`,
    };
  },
};
