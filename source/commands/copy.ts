import { marked, type Tokens } from "marked";
import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { writeClipboard } from "../ink/termio/clipboard.js";

/** Marked also emits indented and unclosed code tokens; only copy complete fences. */
function completeFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  marked.walkTokens(marked.lexer(text), (token) => {
    if (token.type !== "code") return;
    const code = token as Tokens.Code;
    const lines = code.raw.replace(/(?:\r?\n)+$/, "").split("\n");
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
    const closing = /^ {0,3}(`{3,}|~{3,}) *$/.exec(lines.at(-1) ?? "")?.[1];
    if (lines.length > 1 && opening && closing && closing[0] === opening[0] && closing.length >= opening.length) {
      blocks.push(code.text);
    }
  });
  return blocks;
}

/** Handles the /copy command. */
export const copyCommand: SlashCommand = {
  name: "copy",
  description: "Copy an assistant response to the clipboard",
  argumentHint: "[N | code [N] [--response M]]",
  usage: "Usage: /copy [N | code [N] [--response M]]\n\n"
    + "Use /copy [N] to copy the Nth-most-recent assistant response (default: latest).\n"
    + "Use /copy code [N] to copy the Nth complete fenced code block in the latest response (default: first).\n"
    + "Add --response M to take the block from the Mth-most-recent response, numbered as in /copy M.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const messages = context.conversation.getMessages();
    // Only count assistant turns that have at least one non-blank text block.
    // Tool-only turns have no copyable text and should not consume an index slot:
    // without this, /copy 2 would land on a tool-only turn and report "no text"
    // instead of reaching the previous real response.
    const assistantMessages = messages.filter(
      (msg) =>
        msg.role === "assistant" &&
        msg.content.some((b) => b.type === "text" && b.text?.trim()),
    );

    if (assistantMessages.length === 0) {
      return { type: "message", text: "Nothing to copy (no assistant messages found)." };
    }

    const input = args.trim();
    if (/^code(?:\s|$)/.test(input)) {
      const rest = input.slice("code".length).trim();
      const flag = /(?:^|\s)--response(?:\s+(.*))?$/.exec(rest);
      const index = flag ? rest.slice(0, flag.index).trim() : rest;
      const n = index ? Number(index) : 1;
      if ((index && !/^\d+$/.test(index)) || !Number.isSafeInteger(n) || n < 1) {
        return { type: "message", text: "Invalid code block number. Expected a positive integer." };
      }
      const response = flag?.[1]?.trim() ?? "";
      const m = flag ? Number(response) : 1;
      if (flag && (!/^\d+$/.test(response) || !Number.isSafeInteger(m) || m < 1)) {
        return { type: "message", text: "Invalid response number. Expected a positive integer." };
      }
      if (m > assistantMessages.length) {
        return { type: "message", text: `Nothing to copy (only ${assistantMessages.length} assistant message${assistantMessages.length === 1 ? "" : "s"} available).` };
      }
      const where = m === 1 ? "the latest response" : `response -${m}`;
      const responseText = assistantMessages[assistantMessages.length - m].content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const blocks = completeFencedBlocks(responseText);
      if (blocks.length === 0) {
        return { type: "message", text: `Nothing to copy (no complete fenced code blocks in ${where}).` };
      }
      const block = blocks[n - 1];
      if (block === undefined) {
        return {
          type: "message",
          text: `Nothing to copy (only ${blocks.length} fenced code block${blocks.length === 1 ? "" : "s"} available${m === 1 ? "" : ` in ${where}`}).`,
        };
      }
      writeClipboard(process.stdout, block);
      return { type: "message", text: `Copied code block ${n}${m === 1 ? "" : ` from ${where}`} to clipboard.` };
    }

    let n = 1;
    if (input) {
      const parsed = Number(input);
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
