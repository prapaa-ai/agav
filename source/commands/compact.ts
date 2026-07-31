import type { SlashCommand, CommandResult, CommandContext } from "./types.js";

/** Handles the /compact command. */
export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact conversation history to free up context",
  usage: "Usage: /compact\n\nSummarizes and drops older messages to free up context window space.\nHappens automatically when context gets full, but you can trigger it manually.",
  async execute(_args: string, context: CommandContext): Promise<CommandResult> {
    const before = context.conversation.tokenCount;

    context.showStatus("Compacting conversation...");

    let summarize: ((msgs: import("../providers/types.js").Message[]) => Promise<string>) | undefined;

    if (context.provider) {
      const provider = context.provider;
      const model = context.config.model;
      summarize = async (msgs) => {
        let result = "";
        try {
          for await (const event of provider.stream({
            model,
            messages: msgs,
            systemPrompt:
              "Summarize this conversation concisely. Structure your summary as:\n\n" +
              "## Task\nWhat the user asked for (1 sentence)\n\n" +
              "## Changes Made\n- File paths modified and what was changed\n\n" +
              "## Key Findings\n- Bugs found, errors encountered, important observations\n\n" +
              "## Current State\n- What has been completed vs what remains\n- Last approach tried and whether it worked\n\n" +
              "Be brief but preserve ALL file paths, function names, and specific error messages. " +
              "This summary replaces earlier messages — anything not included here is lost.",
            maxTokens: 2048,
            effort: context.config.effort,
          })) {
            if (event.type === "text_delta") result += event.text;
            if (event.type === "usage") {
              context.addTokenUsage({
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheReadTokens: event.cacheReadTokens ?? 0,
                cacheWriteTokens: event.cacheWriteTokens ?? 0,
              });
            }
          }
        } catch {
          return "";
        }
        return result || "";
      };
    }

    const { compacted, droppedCount } = await context.conversation.compactIfNeeded(true, summarize);

    if (!compacted) {
      return {
        type: "message",
        text: `Conversation is already compact (~${before} tokens).`,
      };
    }

    context.saveSession();
    context.refreshDisplay();

    const after = context.conversation.tokenCount;
    return {
      type: "message",
      text: `\x1b[2mCompacted: ${droppedCount} messages summarized, ~${before} → ~${after} tokens (Ctrl+O to see full summary)\x1b[0m`,
    };
  },
};
