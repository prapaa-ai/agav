import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { listSessions, saveSession, type SessionRecord } from "../config/history.js";
import { listResumableSessions, loadResumableSession } from "../sessions/history.js";
import { formatSessionTitle } from "./history.js";
import { isProviderName } from "../config/startup.js";

const MAX_CHECKOUT_MATCHES = 10;

/** Return a session's top-level chat, following parent links defensively. */
function getBranchRoot(session: SessionRecord, byId: Map<string, SessionRecord>): string {
  const seen = new Set<string>();
  let current = session;
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

/** List the saved branches that belong to the active chat. */
async function listBranches(context: CommandContext): Promise<CommandResult> {
  const sessions = await listSessions();

  if (sessions.length === 0) {
    return { type: "message", text: "No saved sessions. Use /branch <name> to create one." };
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const current = context.currentSessionId ? byId.get(context.currentSessionId) : undefined;
  const currentRoot = current ? getBranchRoot(current, byId) : undefined;
  const relatedSessions = currentRoot
    ? sessions.filter((session) => getBranchRoot(session, byId) === currentRoot)
    : [];

  if (relatedSessions.length === 0) {
    return { type: "message", text: "No saved branches for the current chat. Use /branch <name> to create one." };
  }

  const lines = relatedSessions.slice(0, 10).map((s) => {
    const date = new Date(s.createdAt).toLocaleDateString();
    const shortId = s.id.slice(0, 8);
    const marker = s.id === context.currentSessionId ? "*" : " ";
    return `${marker} ${shortId}  ${s.title.slice(0, 50).padEnd(50)}  ${s.messages.length} msgs  ${date}`;
  });

  const footer = relatedSessions.length > 10
    ? `\n  ... and ${relatedSessions.length - 10} more`
    : "";

  return {
    type: "message",
    text: "Branches for current chat (* current):\n" + lines.join("\n") + footer + "\n\nCheck out a branch with: /branch checkout <id>\nResume with: agav --resume <id>",
  };
}

/** Load a saved branch into the active conversation, restoring model/provider like /resume. */
function applyBranch(loaded: SessionRecord, context: CommandContext): CommandResult {
  context.loadSession(loaded);
  context.setModel(loaded.model || context.config.model);
  if (isProviderName(loaded.provider)) {
    context.setProvider(loaded.provider);
  }
  const shortId = loaded.id.slice(0, 8);
  return {
    type: "message",
    preservePaths: true,
    text: `Checked out branch ${shortId}: ${loaded.title} (${loaded.messages.length} messages)`,
  };
}

/** Check out a saved branch of the current chat by ID or unique ID prefix. */
async function checkoutBranch(prefix: string, context: CommandContext): Promise<CommandResult> {
  const sessions = await listResumableSessions();

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const current = context.currentSessionId ? byId.get(context.currentSessionId) : undefined;
  const currentRoot = current ? getBranchRoot(current, byId) : undefined;
  if (!currentRoot) {
    return { type: "message", text: "No active session to check out a branch from. Use /resume <id> to load a session first." };
  }
  const relatedSessions = sessions.filter((session) => getBranchRoot(session, byId) === currentRoot);

  const matches = relatedSessions.filter((session) => session.id.startsWith(prefix));
  const match = relatedSessions.find((session) => session.id === prefix)
    ?? (matches.length === 1 ? matches[0] : undefined);
  if (!match && matches.length > 1) {
    const choices = matches.slice(0, MAX_CHECKOUT_MATCHES)
      .map(({ id, title }) => `${id.slice(0, 8)} · ${formatSessionTitle(title) ?? "Untitled session"}`);
    const omitted = matches.length - choices.length;
    if (omitted > 0) choices.push(`… and ${omitted} more ${omitted === 1 ? "match" : "matches"}.`);
    return {
      type: "message",
      text: [`Ambiguous branch prefix "${prefix}". Use a longer ID or choose one:`, ...choices].join("\n"),
    };
  }
  if (!match) {
    const elsewhere = sessions.find((session) => session.id === prefix || session.id.startsWith(prefix));
    if (elsewhere) {
      return { type: "message", text: `Branch "${prefix}" belongs to another chat, not the current one. Use /resume ${elsewhere.id.slice(0, 8)} to switch to it.` };
    }
    return { type: "message", text: `No branch matching "${prefix}" in the current chat. Use /branch to list branches.` };
  }

  const loaded = await loadResumableSession(match.id);
  if (!loaded) {
    return { type: "message", text: "Failed to load session." };
  }
  return applyBranch(loaded, context);
}

/** Fork a new named session, list branches, or check out a saved branch. */
export const branchCommand: SlashCommand = {
  name: "branch",
  description: "Fork a new session, list branches, or check out a branch",
  argumentHint: "[name|checkout <id>]",
  usage: "Usage: /branch [name|checkout <id>]\n\n  /branch              List all branches of this session\n  /branch experiment   Fork current session into a new branch\n  /branch checkout <id>  Check out a saved branch of the current chat\n\nBranching creates a copy of the current conversation so you can\nexplore a different approach without losing the original.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === "checkout" && parts.length > 1) {
      if (parts.length > 2) {
        return { type: "message", text: "Usage: /branch checkout <id-or-prefix>" };
      }
      return checkoutBranch(parts[1]!, context);
    }

    const name = args.trim();
    if (!name) return listBranches(context);

    const messages = context.conversation.getMessages();
    if (messages.length === 0) {
      return { type: "message", text: "Nothing to branch — conversation is empty." };
    }

    const debug = context.getDebugState();
    const branchId = await saveSession(
      messages,
      context.config.model,
      context.config.provider,
      undefined,
      debug.tokenUsage,
      context.conversation.wasCompacted,
      name,
      context.currentSessionId,
    );
    context.activateSession(branchId, name);

    const shortId = branchId.slice(0, 8);
    return {
      type: "message",
      text: `Branched conversation as "${name}" (${shortId}) with ${messages.length} messages.\nResume with: agav --resume ${shortId}`,
    };
  },
};
