import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { listSessions, type SessionRecord } from "../config/history.js";
import { listResumableSessions, loadResumableSession } from "../sessions/history.js";
import { isProviderName } from "../config/startup.js";
import { pickSession, START_NEW_SESSION } from "../utils/session-picker.js";
import { clearCommand } from "./clear.js";
import { openResourceManager } from "./resource-manager.js";

import { stripVTControlCharacters } from "node:util";
import { visualLen } from "../utils/wrap-text.js";

const MAX_RESUME_MATCHES = 10;
const MAX_RESUME_TITLE_WIDTH = 80;
const titleSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function resumeTitle(title: unknown): string {
  if (typeof title !== "string") return "Untitled session";
  const label = stripVTControlCharacters(title).replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  if (!label) return "Untitled session";
  if (visualLen(label) <= MAX_RESUME_TITLE_WIDTH) return label;

  let width = 0;
  let end = 0;
  for (const { segment, index } of titleSegments.segment(label)) {
    width += visualLen(segment);
    if (width >= MAX_RESUME_TITLE_WIDTH) break;
    end = index + segment.length;
  }
  return label.slice(0, end).trimEnd() + "…";
}

export const historyCommand: SlashCommand = {
  name: "history",
  description: "Browse saved sessions",
  usage: "Usage: /history [list] · /resume <id> to load a session",
  async execute(args, context) {
    if (!args.trim()) {
      const interactive = openResourceManager("history", context);
      if (interactive) return interactive;
    }
    if (args.trim() && args.trim() !== "list") return { type: "message", text: "Usage: /history [list]" };
    const sessions = await listSessions();
    return { type: "message", text: sessions.length ? sessions.map((s) => `${s.id.slice(0, 8)} · ${s.title} · ${s.messages.length} messages`).join("\n") : "No saved sessions." };
  },
};

/** Load a session into the active conversation and restore its model/provider. */
function applySession(loaded: SessionRecord, context: CommandContext): CommandResult {
  context.loadSession(loaded);
  context.setModel(loaded.model || context.config.model);
  if (isProviderName(loaded.provider)) {
    context.setProvider(loaded.provider);
  }
  return {
    type: "message",
    preservePaths: true,
    text: loaded.runtime
      ? `Attached session: ${loaded.title} · ${loaded.runtime.status} · ${loaded.runtime.pendingCount} pending approval(s)\nWorking directory: ${loaded.runtime.cwd}`
      : `Loaded session: ${loaded.title} (${loaded.messages.length} messages)`,
  };
}

/** Resume a previous session via interactive picker or by session ID. */
export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a previous session",
  usage: "Usage: /resume [session-id]\n\n  /resume            Open interactive session picker\n  /resume a1b2c3d4   Load session by ID (prefix match)\n\nSessions are auto-saved on exit. Use --resume from CLI to resume by ID.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const prefix = args.trim();

    // Direct load by session ID prefix
    if (prefix) {
      const sessions = await listResumableSessions();
      const matches = sessions.filter(s => s.id.startsWith(prefix));
      const match = sessions.find(s => s.id === prefix) ?? (matches.length === 1 ? matches[0] : undefined);
      if (!match && matches.length > 1) {
        const choices = matches.slice(0, MAX_RESUME_MATCHES)
          .map(({ id, title }) => `${id} · ${resumeTitle(title)}`);
        const omitted = matches.length - choices.length;
        if (omitted > 0) choices.push(`… and ${omitted} more ${omitted === 1 ? "match" : "matches"}.`);
        return {
          type: "message",
          text: [`Ambiguous session ID prefix "${prefix}". Use a longer ID or choose one:`, ...choices].join("\n"),
        };
      }
      if (!match) {
        return { type: "message", text: `No session matching "${prefix}". Use /resume to browse all sessions.` };
      }
      const loaded = await loadResumableSession(match.id);
      if (!loaded) {
        return { type: "message", text: "Failed to load session." };
      }
      return applySession(loaded, context);
    }

    // Interactive picker
    const sessions = await listResumableSessions();
    if (sessions.length === 0) {
      return { type: "message", text: "No saved sessions." };
    }

    context.setPickerActive(true);
    // pickSession draws straight to stdout, so Ink has to stop repainting
    // before its first write rather than after the next await.
    const resumeTerminal = context.suspendTerminal();
    let session: Awaited<ReturnType<typeof pickSession>>;
    try {
      session = await pickSession(sessions);
    } finally {
      resumeTerminal();
      context.setPickerActive(false);
    }
    context.refreshDisplay();

    if (!session) {
      return { type: "message", text: "Cancelled." };
    }
    // "Start new" from the picker behaves exactly like /new.
    if (session === START_NEW_SESSION) {
      return clearCommand.execute("", context);
    }

    const loaded = await loadResumableSession(session.id);
    if (!loaded) {
      return { type: "message", text: "Failed to load session." };
    }
    return applySession(loaded, context);
  },
};
