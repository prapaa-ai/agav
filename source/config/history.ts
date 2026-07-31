import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import crypto from "node:crypto";
import type { Message } from "../providers/types.js";
import { getAgavDir } from "./config.js";
import { ensureDir } from "../utils/fs.js";

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
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "Empty session";
  if (firstUser.sourceText) return firstUser.sourceText.slice(0, 80);
  if (firstUser.displayText) return firstUser.displayText.slice(0, 80);
  const text = firstUser.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ");
  return text.slice(0, 80) || "Empty session";
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
): Promise<string> {
  const dir = getHistoryDir();
  await ensureDir(dir);

  const id = existingId ?? generateId();
  const existing = existingId ? await loadSession(existingId) : null;
  const sessionName = name ?? existing?.name;
  const branchParentId = parentId ?? existing?.parentId;
  const record: SessionRecord = {
    id,
    createdAt: new Date().toISOString(),
    model,
    provider,
    title: sessionName ?? extractTitle(messages),
    ...(sessionName ? { name: sessionName } : {}),
    ...(branchParentId ? { parentId: branchParentId } : {}),
    messages,
    tokenUsage,
    compacted,
  };

  const filePath = join(dir, `${id}.json`);
  await writeFile(filePath, JSON.stringify(record, null, 2));
  return id;
}

export async function listSessions(): Promise<SessionRecord[]> {
  const dir = getHistoryDir();
  try {
    await ensureDir(dir);
    const files = await readdir(dir);
    const sessions: SessionRecord[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(dir, file), "utf-8");
        const record = JSON.parse(raw) as SessionRecord;
        sessions.push(record);
      } catch {
        // Skip corrupted files
      }
    }

    sessions.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return sessions;
  } catch {
    return [];
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  const dir = getHistoryDir();
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(join(dir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Persist a human-readable name for an existing session. */
export async function renameSession(id: string, name: string): Promise<SessionRecord | null> {
  const record = await loadSession(id);
  const trimmedName = name.trim();
  if (!record || !trimmedName) return null;

  const renamed: SessionRecord = {
    ...record,
    name: trimmedName,
    title: trimmedName,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(getHistoryDir(), `${id}.json`), JSON.stringify(renamed, null, 2));
  return renamed;
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  const dir = getHistoryDir();
  try {
    const filePath = join(dir, `${id}.json`);
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}
