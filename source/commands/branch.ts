import type { SlashCommand, CommandResult, CommandContext } from "./types.js";
import { listSessions, saveSession, type SessionRecord } from "../config/history.js";

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
    text: "Branches for current chat (* current):\n" + lines.join("\n") + footer + "\n\nResume with: agav --resume <id>",
  };
}

/** Fork a new named session or list branches from the active session. */
export const branchCommand: SlashCommand = {
  name: "branch",
  description: "Fork a new session or list branches",
  usage: "Usage: /branch [name]\n\n  /branch              List all branches of this session\n  /branch experiment   Fork current session into a new branch\n\nBranching creates a copy of the current conversation so you can\nexplore a different approach without losing the original.",
  async execute(args: string, context: CommandContext): Promise<CommandResult> {
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
