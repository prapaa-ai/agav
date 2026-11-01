import { open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import type { ContentBlock, Message } from "../providers/types.js";
import { stripTerminalLinks } from "../utils/hyperlink.js";
import { isInternalUserMessage } from "../agent/internal-prompts.js";
import { createExportRedactor } from "../utils/export-redaction.js";

const USAGE = "Usage: /export [json] [sanitize|--sanitize]\n\n"
  + "  /export                 Markdown preview (existing format)\n"
  + "  /export json            Structured retained conversation\n"
  + "  /export sanitize        Markdown with best-effort redaction\n"
  + "  /export json sanitize   JSON with best-effort redaction\n\n"
  + "Saves a timestamped file in the working directory. Options may appear in either order.\n"
  + "JSON preserves retained tool data; Markdown previews tool inputs/results. Earlier trimmed or compacted history cannot be recovered.\n"
  + "Sanitization masks common credentials and home paths, and omits image bytes from JSON. Review before sharing; arbitrary secrets and personal data may remain.\n"
  + "JSON excludes opaque provider replay metadata and is not a session backup. See the Sessions and Memory guide for its schema.";

interface ExportBlock extends Omit<ContentBlock, "providerMetadata" | "toolResultContent"> {
  toolResultContent?: ExportBlock[];
  imageDataOmitted?: true;
}

interface ExportMessage extends Omit<Message, "content" | "internal"> {
  content: ExportBlock[];
}

function projectMessages(messages: Message[], sanitize: boolean) {
  const omissions = { imagePayloads: 0, providerMetadata: 0 };
  const redactor = sanitize ? createExportRedactor(homedir()) : undefined;
  const text = (value: string) => redactor ? redactor.text(value) : value;

  function block(source: ContentBlock): ExportBlock {
    const result: ExportBlock = { type: source.type };
    for (const key of ["text", "toolCallId", "toolName", "toolResult", "imageMediaType"] as const) {
      if (source[key] !== undefined) result[key] = text(source[key]);
    }
    for (const key of ["imageWidth", "imageHeight"] as const) {
      if (source[key] !== undefined) result[key] = source[key];
    }
    if (source.isError !== undefined) result.isError = source.isError;
    if (source.toolInput !== undefined) {
      const input = structuredClone(source.toolInput);
      result.toolInput = (redactor ? redactor.value(input) : input) as Record<string, unknown>;
    }
    if (source.toolResultContent !== undefined) result.toolResultContent = source.toolResultContent.map(block);
    if (source.providerMetadata !== undefined) omissions.providerMetadata++;
    if (source.imageData !== undefined) {
      if (sanitize) {
        result.imageDataOmitted = true;
        omissions.imagePayloads++;
      } else {
        result.imageData = source.imageData;
      }
    }
    return result;
  }

  const projected: ExportMessage[] = messages.map((source) => ({
    role: source.role,
    content: source.content.map(block),
    ...(source.displayText !== undefined ? { displayText: text(source.displayText) } : {}),
    ...(source.sourceText !== undefined ? { sourceText: text(source.sourceText) } : {}),
    ...(source.invocationReason ? { invocationReason: {
      source: source.invocationReason.source,
      detail: text(source.invocationReason.detail),
    } } : {}),
  }));
  return { messages: projected, omissions, text };
}

function markdown(messages: ExportMessage[], model: string, provider: string, exportedAt: string): string {
  const lines: string[] = [];
  lines.push("# Agav Conversation\n");
  lines.push(`**Model:** ${model}  `);
  lines.push(`**Provider:** ${provider}  `);
  lines.push(`**Date:** ${exportedAt}\n`);
  lines.push("---\n");

  for (const msg of messages) {
    if (msg.role === "user") {
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

  return lines.join("\n");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

class PartialExportError extends Error {
  constructor(readonly path: string) { super("Partial export could not be removed"); }
}

async function saveExport(directory: string, stem: string, extension: string, output: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const path = join(directory, `${stem}${attempt ? `-${attempt}` : ""}.${extension}`);
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
    try {
      await file.writeFile(output, "utf8");
      await file.close();
      return path;
    } catch (error) {
      await file.close().catch(() => {});
      // Only a successful exclusive open authorizes removal of this partial file.
      try {
        await unlink(path);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== "ENOENT") throw new PartialExportError(path);
      }
      throw error;
    }
  }
  throw Object.assign(new Error("Export filename collisions"), { code: "EEXIST" });
}

export const exportCommand: SlashCommand = {
  name: "export",
  description: "Export the retained conversation as Markdown or JSON, optionally sanitized",
  usage: USAGE,
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const options = args.trim().split(/\s+/).filter(Boolean);
    if (options.some((option) => !["json", "sanitize", "--sanitize", "--help"].includes(option))) {
      return { type: "message", text: `Unknown export option.\n\n${USAGE}` };
    }
    if (options.includes("--help")) return { type: "message", text: USAGE };
    const json = options.includes("json");
    const sanitize = options.includes("sanitize") || options.includes("--sanitize");

    let output: string;
    let directory: string;
    let stem: string;
    let compacted: boolean;
    let imagePayloads = 0;
    try {
      const messages = context.conversation.getMessages().filter((message) => !isInternalUserMessage(message));
      if (messages.length === 0) return { type: "message", text: "No messages to export." };
      const snapshot = projectMessages(messages, sanitize);
      const now = new Date();
      const model = snapshot.text(context.config.model);
      const provider = snapshot.text(context.config.provider);
      compacted = context.conversation.wasCompacted;
      imagePayloads = snapshot.omissions.imagePayloads;
      if (json) {
        const usage = context.getDebugState()?.tokenUsage;
        output = JSON.stringify({
          schemaVersion: 1,
          model,
          provider,
          exportedAt: now.toISOString(),
          scope: "retained-conversation",
          compacted,
          sanitized: sanitize,
          ...(usage ? { tokenUsage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          } } : {}),
          omissions: snapshot.omissions,
          messages: snapshot.messages,
        }, null, 2) + "\n";
      } else {
        output = markdown(snapshot.messages, model, provider, now.toISOString());
      }
      directory = process.cwd();
      stem = `agav-export-${now.getTime()}${sanitize ? "-sanitized" : ""}`;
    } catch {
      return { type: "message", text: "Could not prepare the conversation for export. No export file was created." };
    }

    try {
      const path = await saveExport(directory, stem, json ? "json" : "md", output);
      const lines = [json || sanitize
        ? `Exported ${sanitize ? "sanitized " : ""}${json ? "JSON" : "Markdown"} to ${path}`
        : `Exported to ${path}`];
      if (sanitize) lines.push("Best-effort redaction applied to common credentials and home paths. Review before sharing.");
      if (json && imagePayloads) lines.push(`Omitted ${imagePayloads} image payload(s); image contents cannot be sanitized.`);
      if (compacted) lines.push("Earlier messages were compacted; this export contains only the retained conversation.");
      return { type: "message", text: lines.join("\n"), preservePaths: true };
    } catch (error) {
      if (error instanceof PartialExportError) {
        return { type: "message", text: `Export failed. A partial file may remain at ${error.path}; remove it before sharing.`, preservePaths: true };
      }
      const code = errorCode(error);
      const reason = code === "EACCES" || code === "EPERM" || code === "EROFS"
        ? "The working directory is not writable. Check its permissions and try again."
        : code === "ENOSPC" || code === "EDQUOT" ? "Free some disk space and try again."
        : code === "EEXIST" ? "Export filenames are already in use. Try again."
        : "Check the working directory and available disk space, then try again.";
      return { type: "message", text: `Could not save the export. ${reason}`, preservePaths: true };
    }
  },
};
