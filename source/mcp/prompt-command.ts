import type { SlashCommand, CommandResult, CommandContext } from "../commands/types.js";
import type { MCPPrompt } from "./types.js";
import type { MCPManager } from "./manager.js";

// Builds a slash command that renders an MCP prompt template and submits it to the conversation.
export function createPromptCommand(prompt: MCPPrompt, manager: MCPManager): SlashCommand {
  const declaredArgs = prompt.arguments ?? [];
  const argumentHint = declaredArgs.length > 0
    ? declaredArgs.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" ")
    : undefined;

  return {
    name: prompt.name,
    description: `[MCP: ${prompt.serverName}] ${prompt.description ?? "Prompt template"}`,
    ...(argumentHint ? { argumentHint } : {}),
    async execute(args: string, _context: CommandContext): Promise<CommandResult> {
      const values = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
      const parsedArgs: Record<string, string> = {};
      declaredArgs.forEach((arg, i) => {
        if (values[i] !== undefined) parsedArgs[arg.name] = values[i];
      });

      const missingRequired = declaredArgs
        .filter((arg) => arg.required && parsedArgs[arg.name] === undefined)
        .map((arg) => arg.name);
      if (missingRequired.length > 0) {
        const usage = argumentHint ? `/${prompt.name} ${argumentHint}` : `/${prompt.name}`;
        return {
          type: "message",
          text: `Missing required argument${missingRequired.length > 1 ? "s" : ""}: ${missingRequired.join(", ")}. Usage: ${usage}`,
        };
      }

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
