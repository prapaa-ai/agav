import { listSessions, loadSession, type SessionRecord } from "../config/history.js";
import { isInternalUserMessage } from "../agent/internal-prompts.js";
import { SessionRuntimeStore, assertSessionRuntimeId, type SessionRuntimeRecord } from "./store.js";
import { readSessionSnapshot } from "./client.js";

/** Runtime transcripts are authoritative, including empty, not-yet-saved conversations. */
async function runtimeSession(store: SessionRuntimeStore, record: SessionRuntimeRecord, saved?: SessionRecord | null): Promise<SessionRecord> {
  const snapshot = await readSessionSnapshot(record.id, store);
  record = snapshot.record;
  const firstUser = record.messages.find(message => message.role === "user" && !isInternalUserMessage(message))
    ?? record.messages.find(message => message.role === "user");
  const text = firstUser?.sourceText ?? firstUser?.displayText ?? firstUser?.content
    .filter(block => block.type === "text").map(block => block.text).join(" ");
  const approvals = snapshot.approvals;
  return {
    ...saved,
    id: record.id,
    createdAt: record.createdAt,
    model: record.model,
    provider: record.provider,
    ...(record.title ? { name: record.title } : {}),
    title: record.title ?? saved?.title ?? (text?.slice(0, 80) || "Empty session"),
    messages: record.messages,
    compacted: record.compacted,
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
  const updated = new Map(runtimes.map(record => [record.id, record.updatedAt]));
  for (const record of runtimes) {
    try { sessions.set(record.id, await runtimeSession(store, record, sessions.get(record.id))); }
    catch (error) {
      // Deletion may race the discovery/read pair. Only disappearance is benign.
      if (await store.read(record.id) !== undefined) throw error;
      sessions.delete(record.id);
    }
  }
  return [...sessions.values()].sort((a, b) =>
    Date.parse(updated.get(b.id) ?? b.createdAt) - Date.parse(updated.get(a.id) ?? a.createdAt));
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
