import { readFile, readdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";
import type { Message } from "../providers/types.js";
import { SessionRuntimeStore, assertSessionRuntimeId, type SessionRuntimeRecord, type SessionRuntimeStatus } from "../sessions/store.js";
import type { PermissionMode } from "./config.js";
import { getAgavDir } from "./config.js";
import { isInternalUserMessage } from "../agent/internal-prompts.js";
import { ensureDir } from "../utils/fs.js";
import { writeAtomic } from "../background-jobs/storage/atomic-file.js";

export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  model: string;
  provider: string;
  title: string;
  name?: string;
  parentId?: string;
  messages: Message[];
  tokenUsage?: SessionTokenUsage;
  compacted?: boolean;
  runtime?: { generation: string; status: SessionRuntimeStatus; pendingCount: number; cwd: string };
  /**
   * Last activity time for saved sessions and runtime snapshots. Legacy history
   * may omit this field, so consumers fall back to `createdAt`. Surfaced by
   * {@link listResumableSessions} so the resume picker can sort by recency
   * without re-reading every runtime.
   */
  updatedAt?: string;
  /**
   * Working directory the session ran in. Sourced from the runtime record, so
   * it is absent for saved-only sessions that never produced a runtime; the
   * resume picker buckets those under an "unknown project" group.
   */
  cwd?: string;
  /**
   * The permission mode in force for this session, persisted so a resume
   * restores the mode the user was last running under instead of silently
   * falling back to the config default. Absent on sessions saved before this
   * field existed; resume treats that as "use the config default".
   */
  permissionMode?: PermissionMode;
}

/** Resolve the directory where serialized chat sessions are stored on disk. */
function getHistoryDir(): string {
  return join(getAgavDir(), "history");
}

/** Generate a stable opaque session id for filenames and resume lookups. */
function generateId(): string {
  return crypto.randomUUID();
}

/** Derive a short human-readable title from the first user message in a session. */
function extractTitle(messages: Message[]): string {
  // A session whose history was compacted starts with the summary the agent
  // wrote, not with anything the user said — titling it from that names the
  // session after its own boilerplate.
  const firstUser = messages.find((m) => m.role === "user" && !isInternalUserMessage(m))
    ?? messages.find((m) => m.role === "user");
  if (!firstUser) return "Empty session";
  if (firstUser.sourceText) return firstUser.sourceText.slice(0, 80);
  if (firstUser.displayText) return firstUser.displayText.slice(0, 80);
  const text = firstUser.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ");
  return text.slice(0, 80) || "Empty session";
}

/** Legacy history IDs may contain dots or spaces, but must remain a single filename. */
function historyPath(id: string): string {
  if (!id || /[/\\\0]/.test(id) || id === "." || id === "..") throw new Error(`Invalid session id: ${id}`);
  return join(getHistoryDir(), `${id}.json`);
}

function supportsRuntime(id: string): boolean {
  try { assertSessionRuntimeId(id); return true; } catch { return false; }
}

const terminal = (status: SessionRuntimeStatus) => ["completed", "failed", "interrupted", "cancelled"].includes(status);

/** Serialize history mutation with runtime creation, checkpoints, rename and deletion. */
async function withRuntimeLock<T>(id: string, fn: (store?: SessionRuntimeStore) => Promise<T>): Promise<T> {
  historyPath(id);
  if (!supportsRuntime(id)) return fn();
  const store = new SessionRuntimeStore();
  return store.lock(id, () => fn(store));
}

export async function saveSession(
  messages: Message[],
  model: string,
  provider: string,
  existingId?: string,
  tokenUsage?: SessionTokenUsage,
  compacted?: boolean,
  name?: string,
  parentId?: string,
  permissionMode?: PermissionMode,
): Promise<string> {
  const id = existingId ?? generateId();
  return withRuntimeLock(id, async store => {
    const runtime = await store?.read(id);
    // Only generation-fenced worker checkpoints may mirror an active execution.
    if (runtime && !terminal(runtime.status)) return id;
    const existing = existingId ? await loadSession(existingId) : null;
    const sessionName = name ?? runtime?.name ?? existing?.name ?? runtime?.title;
    const branchParentId = parentId ?? existing?.parentId;
    // An explicit mode wins; otherwise the runtime is authoritative, then saved history.
    const effectivePermissionMode = permissionMode ?? runtime?.permissionMode ?? existing?.permissionMode;
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id, createdAt: runtime?.createdAt ?? existing?.createdAt ?? now, updatedAt: now, model, provider,
      title: sessionName ?? extractTitle(messages),
      ...(sessionName ? { name: sessionName } : {}),
      ...(branchParentId ? { parentId: branchParentId } : {}),
      messages, tokenUsage, compacted,
      ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
    };
    await writeAtomic(historyPath(id), JSON.stringify(record, null, 2));
    // Local continuations may update a terminal snapshot, never a live owner.
    if (runtime && terminal(runtime.status)) {
      await store!.update(id, runtime.generation, current => {
        current.messages = messages;
        current.compacted = compacted;
        current.tokenUsage = tokenUsage;
        current.model = model;
        if (["anthropic", "openai", "openrouter", "nvidia", "deepseek", "ollama", "gemini", "vertex-ai"].includes(provider)) {
          current.provider = provider as typeof current.provider;
        }
        current.title = record.title;
        current.name = sessionName;
        if (effectivePermissionMode) current.permissionMode = effectivePermissionMode;
      });
    }
    return id;
  });
}

/** Change terminal policy only, preserving the authoritative worker transcript and generation. */
export async function saveSessionPermissionMode(id: string, generation: string, mode: PermissionMode): Promise<void> {
  const store = new SessionRuntimeStore();
  await store.lock(id, async () => {
    const runtime = await store.read(id);
    if (!runtime || runtime.generation !== generation) throw new Error(`Missing or stale session runtime generation: ${id}`);
    // A live worker owns its policy as well as its transcript. Local choices apply to its continuation.
    if (!terminal(runtime.status)) return;
    const { clampPermissionMode } = await import("./org-config.js");
    const updated = await store.update(id, generation, current => {
      current.permissionMode = clampPermissionMode(mode, current.permissionFloor);
    });
    await saveSessionRuntime(updated, store);
  });
}

/** Worker-owned history mirror. Fenced by generation; never writes the runtime. */
export async function saveSessionRuntime(record: SessionRuntimeRecord, store = new SessionRuntimeStore()): Promise<string> {
  return store.lock(record.id, async () => {
    const current = await store.read(record.id);
    if (!current || current.generation !== record.generation) throw new Error(`Missing or stale session runtime generation: ${record.id}`);
    const existing = await loadSession(record.id);
    // A rename may have happened since the worker obtained its snapshot.
    const name = current.name ?? existing?.name ?? current.title;
    const saved: SessionRecord = {
      ...existing,
      id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, model: record.model, provider: record.provider,
      title: name ?? extractTitle(record.messages),
      ...(name ? { name } : {}),
      messages: record.messages, compacted: record.compacted, tokenUsage: record.tokenUsage,
      permissionMode: current.permissionMode,
    };
    await writeAtomic(historyPath(record.id), JSON.stringify(saved, null, 2));
    return record.id;
  });
}

export async function listSessions(): Promise<SessionRecord[]> {
  const dir = getHistoryDir();
  try {
    await ensureDir(dir);
    const files = await readdir(dir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const sessions = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const raw = await readFile(join(dir, file), "utf-8");
          return JSON.parse(raw) as SessionRecord;
        } catch {
          return null;
        }
      }),
    );

    return sessions
      .filter((s): s is SessionRecord => s !== null)
      .sort(
        (a, b) =>
          new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime(),
      );
  } catch {
    return [];
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  return withRuntimeLock(id, async store => {
    const runtime = await store?.read(id);
    if (runtime && !terminal(runtime.status)) return false;
    let removedHistory = false;
    try { await unlink(historyPath(id)); removedHistory = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (runtime) await rm(store!.directory(id), { recursive: true, force: true });
    return removedHistory || runtime !== undefined;
  });
}

/** Rename metadata without overwriting a worker-owned transcript. */
export async function renameSession(id: string, name: string): Promise<SessionRecord | null> {
  const trimmedName = name.trim();
  if (!trimmedName) return null;
  return withRuntimeLock(id, async store => {
    const runtime = await store?.read(id);
    const saved = await loadSession(id);
    if (!runtime && !saved) return null;
    if (runtime) {
      const updated = await store!.update(id, runtime.generation, current => { current.title = trimmedName; current.name = trimmedName; });
      // The runtime remains authoritative. Only mirror metadata when history already exists.
      if (saved) await writeAtomic(join(getHistoryDir(), `${id}.json`), JSON.stringify({ ...saved, title: trimmedName, name: trimmedName }, null, 2));
      const { listPendingApprovals } = await import("../sessions/approvals.js");
      const pendingCount = (await listPendingApprovals(store!, id)).length;
      return { ...saved, id, createdAt: updated.createdAt, model: updated.model, provider: updated.provider,
        title: trimmedName, name: trimmedName, messages: updated.messages, compacted: updated.compacted, tokenUsage: updated.tokenUsage ?? saved?.tokenUsage,
        updatedAt: updated.updatedAt, cwd: updated.cwd,
        runtime: { generation: updated.generation, status: updated.status, pendingCount, cwd: updated.cwd } };
    }
    const renamed: SessionRecord = { ...saved!, name: trimmedName, title: trimmedName, updatedAt: new Date().toISOString() };
    await writeAtomic(join(getHistoryDir(), `${id}.json`), JSON.stringify(renamed, null, 2));
    return renamed;
  });
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  try {
    const filePath = historyPath(id);
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}
