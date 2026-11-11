import { join } from "node:path";
import { warnSessionDiscovery } from "./approvals.js";
import { listSessions, loadSession, type SessionRecord } from "../config/history.js";
import { isInternalUserMessage } from "../agent/internal-prompts.js";
import { SessionRuntimeStore, assertSessionRuntimeId, type SessionRuntimeRecord } from "./store.js";
import { readSessionSnapshot, readSessionListingSnapshot } from "./client.js";

/**
 * Runtime transcripts are authoritative, including empty, not-yet-saved conversations.
 *
 * `read` selects the snapshot strategy: load-time resumes use the full
 * {@link readSessionSnapshot} (coordinator-reconciled), while the resume picker
 * passes {@link readSessionListingSnapshot} to skip the per-session coordinator
 * poll that otherwise makes listing scale poorly with active sessions.
 */
async function runtimeSession(
  store: SessionRuntimeStore,
  record: SessionRuntimeRecord,
  saved?: SessionRecord | null,
  read = readSessionSnapshot,
): Promise<SessionRecord> {
  const snapshot = await read(record.id, store);
  record = snapshot.record;
  if (record.messages.some(message => !message || typeof message.role !== "string" || !Array.isArray(message.content) ||
      message.content.some(block => !block || typeof block.type !== "string" || (block.type === "text" && typeof block.text !== "string")))) {
    throw new Error(`Corrupt resumable session transcript: ${record.id}`);
  }
  const firstUser = record.messages.find(message => message.role === "user" && !isInternalUserMessage(message))
    ?? record.messages.find(message => message.role === "user");
  const text = firstUser?.sourceText ?? firstUser?.displayText ?? firstUser?.content
    .filter(block => block.type === "text").map(block => block.text).join(" ");
  const approvals = snapshot.approvals;
  return {
    ...saved,
    id: record.id,
    // A legacy session may receive its first runtime long after it was created.
    createdAt: saved?.createdAt ?? saved?.updatedAt ?? record.createdAt,
    model: record.model,
    provider: record.provider,
    ...(record.title ? { name: record.title } : {}),
    title: record.title ?? saved?.title ?? (text?.slice(0, 80) || "Empty session"),
    messages: record.messages,
    tokenUsage: record.tokenUsage ?? saved?.tokenUsage,
    compacted: record.compacted,
    permissionMode: record.permissionMode,
    updatedAt: record.updatedAt,
    cwd: record.cwd,
    runtime: {
      generation: record.generation,
      status: record.status,
      pendingCount: approvals.filter(item => item.generation === record.generation).length,
      cwd: record.cwd,
    },
  };
}

/** Merge saved history with live executions without requiring a transcript save first. */
export async function listResumableSessions(): Promise<SessionRecord[]> {
  const store = new SessionRuntimeStore();
  const [saved, runtimes] = await Promise.all([listSessions(), store.list()]);
  const sessions = new Map(saved.map(record => [record.id, record]));
  // Resolve every runtime concurrently rather than serially: the picker blocks
  // on this call, and each entry is independent disk work. A failed snapshot
  // must not hide healthy siblings or offer this runtime's stale saved
  // transcript, so failures delete the entry and warn without aborting the rest.
  const resolved = await Promise.all(runtimes.map(async record => {
    try { return { id: record.id, session: await runtimeSession(store, record, sessions.get(record.id), readSessionListingSnapshot) }; }
    catch (error) {
      await warnSessionDiscovery(join(store.directory(record.id), "runtime.json"), error);
      return { id: record.id, session: null };
    }
  }));
  for (const { id, session } of resolved) {
    if (session) sessions.set(id, session);
    else sessions.delete(id);
  }
  return [...sessions.values()].sort((a, b) =>
    Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt));
}

/** Re-read the runtime at selection time rather than loading a stale saved transcript. */
export async function loadResumableSession(id: string): Promise<SessionRecord | null> {
  const saved = await loadSession(id);
  // Legacy history does not impose the runtime store's identifier constraints.
  try { assertSessionRuntimeId(id); } catch { return saved; }
  const store = new SessionRuntimeStore();
  const record = await store.read(id);
  return record ? runtimeSession(store, record, saved) : saved;
}
