import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { stripTerminalLinks } from "../utils/hyperlink.js";
import { isInternalUserMessage } from "../agent/internal-prompts.js";

/** Handles the /export command. */
export const exportCommand: SlashCommand = {
  name: "export",
  description: "Export conversation as a markdown file",
  usage: "Usage: /export\n\nSaves the current conversation to a timestamped .md file in the working directory.\nIncludes all messages, tool calls, and responses.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const messages = context.conversation.getMessages();
    if (messages.length === 0) {
      return { type: "message", text: "No messages to export." };
    }

    const lines: string[] = [];
    lines.push("# Agav Conversation\n");
    lines.push(`**Model:** ${context.config.model}  `);
    lines.push(`**Provider:** ${context.config.provider}  `);
    lines.push(`**Date:** ${new Date().toISOString()}\n`);
    lines.push("---\n");

    for (const msg of messages) {
      if (msg.role === "user") {
        // Prompts the agent injected to steer itself are not the user speaking,
        // so exporting them under "You" misattributes them.
        if (isInternalUserMessage(msg)) continue;
        const text = stripTerminalLinks(msg.displayText ?? msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"));
        const toolResults = msg.content.filter((b) => b.type === "tool_result");

        if (text) {
          lines.push(`## You\n\n${text}\n`);
        }
        for (const tr of toolResults) {
          lines.push(`> **Tool Result** (${tr.toolCallId}): ${tr.isError ? "ERROR" : "OK"}`);
          lines.push(`> \`\`\`\n> ${(tr.toolResult ?? "").slice(0, 500)}\n> \`\`\`\n`);
        }
      } else if (msg.role === "assistant") {
        const text = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const toolCalls = msg.content.filter((b) => b.type === "tool_use");

        lines.push(`## Agav\n`);
        if (text) lines.push(`${text}\n`);
        for (const tc of toolCalls) {
          lines.push(`> **${tc.toolName}** \`${JSON.stringify(tc.toolInput).slice(0, 200)}\`\n`);
        }
      }
    }

    const filename = `agav-export-${Date.now()}.md`;
    const filepath = join(process.cwd(), filename);
    await writeFile(filepath, lines.join("\n"), "utf-8");

    return { type: "message", text: `Exported to ${filepath}` };
  },
};
