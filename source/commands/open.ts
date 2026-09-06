import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { listAttachments, getAttachment } from "../utils/attachment-registry.js";
import { openTarget } from "../utils/open-target.js";

/**
 * The keyboard path required for every open/preview action. Mouse reporting
 * can be disabled outright in several terminals (iTerm2, Ghostty, Konsole,
 * PuTTY), is opt-in in Apple Terminal, and ctrl+click is swallowed by xterm —
 * `/open` with no argument doubles as the discovery surface for what a click
 * would have done.
 */
export const openCommand: SlashCommand = {
  name: "open",
  description: "List or open/preview an attachment from this session",
  usage: "Usage: /open — list every attachment in the session\n/open <n> — open or preview attachment #n",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const trimmed = args.trim();

    if (!trimmed) {
      const attachments = listAttachments();
      if (attachments.length === 0) {
        return { type: "message", text: "No attachments in this session yet." };
      }
      const lines = attachments.map((a) => `  #${a.id} [${a.kind}] ${a.summary}`);
      return { type: "message", text: `Attachments:\n${lines.join("\n")}\n\nUse /open <n> to open or preview one.` };
    }

    const id = Number(trimmed);
    if (!Number.isInteger(id)) {
      return { type: "message", text: `"${trimmed}" is not a valid attachment number. Use /open to list them.` };
    }

    const attachment = getAttachment(id);
    if (!attachment) {
      return { type: "message", text: `Attachment #${id} was not found or is no longer available.` };
    }

    if (attachment.kind === "paste" && attachment.source.type === "text") {
      const preview = attachment.source.text.length > 500
        ? `${attachment.source.text.slice(0, 500)}\n...(truncated — ${attachment.source.text.length} chars total)`
        : attachment.source.text;
      return { type: "message", text: `Pasted #${id} (${attachment.summary}):\n\n${preview}` };
    }

    if (attachment.kind === "image" && attachment.source.type === "image") {
      const { spoolImageToTempFile } = await import("../utils/open-external.js");
      try {
        const path = attachment.source.spoolPath
          ?? (attachment.source.base64 ? await spoolImageToTempFile(attachment.source.base64, attachment.source.mediaType) : null);
        if (!path) return { type: "message", text: `Image #${id} data is no longer available.` };
        const outcome = await openTarget({ kind: "file", absPath: path });
        return { type: "message", text: outcome.message };
      } catch (err) {
        return { type: "message", text: `Cannot open image #${id}: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    if (attachment.kind === "file" && attachment.source.type === "file") {
      const outcome = await openTarget({ kind: "file", absPath: attachment.source.absPath });
      return { type: "message", text: outcome.message };
    }

    return { type: "message", text: `Attachment #${id} cannot be opened.` };
  },
};
