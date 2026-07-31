import type { SlashCommand, CommandResult, CommandContext } from "../commands/types.js";
import type { MCPPrompt } from "./types.js";
import type { MCPManager } from "./manager.js";

// Builds a slash command that renders an MCP prompt template and submits it to the conversation.
export function createPromptCommand(prompt: MCPPrompt, manager: MCPManager): SlashCommand {
  return {
    name: prompt.name,
    description: `[MCP: ${prompt.serverName}] ${prompt.description ?? "Prompt template"}`,
    async execute(args: string, _context: CommandContext): Promise<CommandResult> {
      const values = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
      const parsedArgs: Record<string, string> = {};
      (prompt.arguments ?? []).forEach((arg, i) => {
        if (values[i] !== undefined) parsedArgs[arg.name] = values[i];
      });

      try {
        const { messages } = await manager.getPrompt(prompt.serverName, prompt.name, parsedArgs);
        const text = messages
          .map((m) => (m.role === "assistant" ? `[assistant]: ${m.content.text ?? ""}` : m.content.text ?? ""))
          .join("\n\n")
          .trim();

        if (!text) {
          return { type: "message", text: `Prompt ${prompt.name} returned no content.` };
        }

        return { type: "submit", text };
      } catch (err) {
        return {
          type: "message",
          text: `Failed to load prompt ${prompt.name}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
