import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { Reviewer, detectProjectTestCommand } from "../agent/reviewer.js";
import { loadConfig } from "../config/config.js";

export const reviewCommand: SlashCommand = {
  name: "review",
  description: "Run automated project test verification or check reviewer configuration",
  usage:
    "Usage: /review [status | run <command> | <command>]\n\n" +
    "  /review             Execute detected project tests and inspect verification status\n" +
    "  /review status      Show detected test runner and automated review configuration\n" +
    "  /review run <cmd>   Execute a custom test/verification command",

  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const cwd = context.toolRegistry?.getDefaultContext()?.cwd ?? process.cwd();
    const config = await loadConfig();
    const trimmed = args.trim();

    if (trimmed === "status") {
      const detected = detectProjectTestCommand(cwd);
      return {
        type: "message",
        text: [
          "Automated Review Configuration:",
          `  Workspace: ${cwd}`,
          `  Detected Test Command: ${detected ? `\`${detected}\`` : "None detected"}`,
          `  Configured Command: ${config.reviewCommand ? `\`${config.reviewCommand}\`` : "None (uses detected)"}`,
          `  Auto-Review After Edits: ${config.autoReview ? "ENABLED" : "DISABLED"}`,
          `  Max Repair Turns: ${config.maxReviewRetries ?? 3}`,
        ].join("\n"),
      };
    }

    let customCommand: string | undefined;
    if (trimmed.startsWith("run ")) {
      customCommand = trimmed.slice(4).trim();
    } else if (trimmed.length > 0) {
      customCommand = trimmed;
    } else {
      customCommand = config.reviewCommand;
    }

    context.showStatus?.("Running automated verification tests...");

    try {
      const result = await Reviewer.runReview({
        cwd,
        command: customCommand,
      });

      const formatted = Reviewer.formatSummary(result);
      return {
        type: "message",
        text: formatted,
      };
    } catch (err: any) {
      return {
        type: "message",
        text: `Review execution error: ${err?.message ?? String(err)}`,
      };
    }
  },
};
