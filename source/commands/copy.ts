import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { writeClipboard } from "../ink/termio/clipboard.js";

/** Handles the /copy command. */
export const copyCommand: SlashCommand = {
  name: "copy",
  description: "Copy an assistant response to the clipboard",
  usage: "Usage: /copy [N]\n\nCopies the most recent assistant response to the clipboard. Use an optional number N to copy the Nth-most-recent assistant response.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const messages = context.conversation.getMessages();
    const assistantMessages = messages.filter((msg) => msg.role === "assistant");

    if (assistantMessages.length === 0) {
      return { type: "message", text: "Nothing to copy (no assistant messages found)." };
    }

    let n = 1;
    if (args.trim()) {
      const parsed = Number(args.trim());
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { type: "message", text: "Invalid message number. Expected a positive integer." };
      }
      n = parsed;
    }

    if (n > assistantMessages.length) {
      return { type: "message", text: `Nothing to copy (only ${assistantMessages.length} assistant message${assistantMessages.length === 1 ? "" : "s"} available).` };
    }

    const targetMsg = assistantMessages[assistantMessages.length - n];
    const textBlocks = targetMsg.content.filter((b) => b.type === "text");
    const textToCopy = textBlocks.map((b) => b.text).join("\n");

    if (!textToCopy.trim()) {
      return { type: "message", text: "Selected assistant response contains no text." };
    }

    writeClipboard(process.stdout, textToCopy);

    return { 
      type: "message", 
      text: n === 1 ? "Copied last response to clipboard." : `Copied response -${n} to clipboard.` 
    };
  },
};
