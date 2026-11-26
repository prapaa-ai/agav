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
const MAX_SESSION_TITLE_WIDTH = 80;
const titleSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function formatSessionTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined;
  const label = stripVTControlCharacters(title).replace(/\s+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  if (!label) return undefined;
  if (visualLen(label) <= MAX_SESSION_TITLE_WIDTH) return label;

  let width = 0;
  let end = 0;
  for (const { segment, index } of titleSegments.segment(label)) {
    width += visualLen(segment);
    if (width >= MAX_SESSION_TITLE_WIDTH) break;
    end = index + segment.length;
  }
  return label.slice(0, end).trimEnd() + "…";
}

const HISTORY_USAGE = "Usage: /history [list [--limit <count>] [--provider <name>] [--model <name>] [--full-ids]]";

export const historyCommand: SlashCommand = {
  name: "history",
  description: "Browse saved sessions",
  argumentHint: "[list [--limit <count>] [--provider <name>] [--model <name>] [--full-ids]]",
  usage: `${HISTORY_USAGE} · /resume <id> to load a session`,
  async execute(args, context) {
    const input = args.trim();
    let limit: number | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let fullIds = false;
    if (!input) {
      const interactive = openResourceManager("history", context);
      if (interactive) return interactive;
    } else {
      const [action, ...options] = input.split(/\s+/);
      if (action !== "list") return { type: "message", text: HISTORY_USAGE };
      const seen = new Set<string>();
      for (let i = 0; i < options.length; i += 2) {
        const flag = options[i]!;
        const value = options[i + 1];
        if (seen.has(flag)) return { type: "message", text: HISTORY_USAGE };
        seen.add(flag);
        if (flag === "--full-ids") {
          // A switch with no value: step back so the next token is read as a flag.
          fullIds = true;
          i -= 1;
        } else if (flag === "--limit") {
          limit = Number(value);
          if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1) {
            return { type: "message", text: "--limit requires a positive safe integer. " + HISTORY_USAGE };
          }
          if (options[i + 2] && !options[i + 2]!.startsWith("--")) {
            return { type: "message", text: "--limit requires a positive safe integer. " + HISTORY_USAGE };
          }
        } else if (flag === "--provider" || flag === "--model") {
          if (!value || value.startsWith("--")) {
            return { type: "message", text: `${flag} requires a name. ${HISTORY_USAGE}` };
          }
          if (flag === "--provider") provider = value;
          else model = value.toLowerCase();
        } else return { type: "message", text: HISTORY_USAGE };
      }
    }

    const saved = await listSessions();
    const filtered = provider !== undefined || model !== undefined;
    const sessions = filtered ? saved.filter((session) =>
      (provider === undefined || session.provider === provider) &&
      (model === undefined || session.model?.toLowerCase() === model)
    ) : saved;
    if (sessions.length === 0) {
      return { type: "message", text: filtered ? "No saved sessions match the filters." : "No saved sessions." };
    }
    const shown = limit === undefined ? sessions : sessions.slice(0, limit);
    const lines = shown.map((s) => `${fullIds ? s.id : s.id.slice(0, 8)} · ${formatSessionTitle(s.title) ?? "Untitled session"} · ${s.messages.length} messages`);
    if (filtered || shown.length < sessions.length) lines.push(`Showing ${shown.length} of ${sessions.length} saved sessions.`);
    return { type: "message", text: lines.join("\n") };
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
          .map(({ id, title }) => `${id} · ${formatSessionTitle(title) ?? "Untitled session"}`);
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
