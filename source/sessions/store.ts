import { promises as fs } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { getAgavDir, type PermissionMode, type EffortLevel, type AgavConfig } from "../config/config.js";
import type { SessionTokenUsage } from "../config/history.js";
import type { Message } from "../providers/types.js";
import { createExclusive, readJsonIfExists, writeAtomic } from "../background-jobs/storage/atomic-file.js";
import { BackgroundJobError } from "../background-jobs/types.js";
import { withJobLock } from "../background-jobs/storage/single-writer-lock.js";

export type SessionRuntimeStatus = "starting" | "running" | "needs-approval" | "completed" | "failed" | "interrupted" | "cancelled";
/** Only selected runtime settings belong here, never a Config object containing credentials. */
export interface SessionRuntimeRecord {
  version: 1;
  id: string;
  generation: string;
  cwd: string;
  model: string;
  provider: AgavConfig["provider"];
  permissionMode: PermissionMode;
  backgroundPermissionMode: PermissionMode;
  permissionFloor?: PermissionMode;
  sandboxRequired: boolean;
  effort?: EffortLevel;
  maxTokens?: number;
  /** Non-secret provider routing selected by the ongoing session. Headers/credentials are reloaded. */
  connection?: Pick<AgavConfig, "openaiApi" | "openaiBaseURL" | "ollamaEndpoint" | "ollamaHost" | "ollamaPort" | "vertexAILocation">;
  systemPrompt?: string;
  allowedTools?: string[];
  hooks?: AgavConfig["hooks"];
  iterationsBudget?: { remaining: number; total: number };
  compacted?: boolean;
  messages: Message[];
  toolCalls?: import("../components/tool-call-display.js").ToolCallInfo[];
  subagentStates?: import("../agent/subagent-types.js").SubagentProgress[];
  streamingText?: string;
  thinkingText?: string;
  title?: string;
  name?: string;
  tokenUsage?: SessionTokenUsage;
  status: SessionRuntimeStatus;
  createdAt: string;
  updatedAt: string;
  jobId?: string;
  ownerPid?: number;
  cancelRequested?: boolean;
  cancelledSubagents?: string[];
  error?: string;
}
export type CreateSessionRuntime = Omit<SessionRuntimeRecord, "version" | "id" | "generation" | "status" | "createdAt" | "updatedAt" | "messages" | "backgroundPermissionMode"> &
  Partial<Pick<SessionRuntimeRecord, "id" | "generation" | "messages" | "backgroundPermissionMode">>;
const STATUSES = new Set<string>(["starting", "running", "needs-approval", "completed", "failed", "interrupted", "cancelled"]);
const MODES = new Set<string>(["ask", "auto-accept", "deny-writes"]);
export function assertSessionRuntimeId(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error(`Invalid session runtime id: ${id}`);
}
function validate(record: SessionRuntimeRecord, id: string): void {
  if (!record || record.version !== 1 || record.id !== id) throw new Error(`Invalid session runtime: ${id}`);
  assertSessionRuntimeId(record.id);
  assertSessionRuntimeId(record.generation);
  if (typeof record.cwd !== "string" || !isAbsolute(record.cwd) || typeof record.model !== "string" || typeof record.provider !== "string" ||
      !MODES.has(record.permissionMode) || !MODES.has(record.backgroundPermissionMode) || (record.permissionFloor !== undefined && !MODES.has(record.permissionFloor)) ||
      typeof record.sandboxRequired !== "boolean" || !STATUSES.has(record.status) || !Array.isArray(record.messages) ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error(`Corrupt session runtime: ${id}`);
}

// Shared across store instances; only the owning async stack may reenter.
const lockTails = new Map<string, Promise<void>>();
const lockContext = new AsyncLocalStorage<Set<string>>();

export class SessionRuntimeStore {
  constructor(readonly root = join(getAgavDir(), "session-runtimes")) {}
  directory(id: string): string { assertSessionRuntimeId(id); return join(this.root, id); }
  private path(id: string): string { return join(this.directory(id), "runtime.json"); }
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    assertSessionRuntimeId(id);
    const key = resolve(this.directory(id));
    const held = lockContext.getStore();
    if (held?.has(key)) return fn();
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((done) => { release = done; });
    lockTails.set(key, tail);
    try {
      await previous;
      await fs.mkdir(join(this.root, "locks"), { recursive: true, mode: 0o700 });
      // withJobLock fails immediately on contention. Retry acquisition, never the callback.
      for (let attempt = 0; ; attempt++) {
        let entered = false;
        try {
          return await withJobLock(this.root, id, async () => {
            entered = true;
            const next = new Set(held);
            next.add(key);
            try { return await lockContext.run(next, fn); }
            finally { next.delete(key); }
          });
        } catch (error) {
          if (entered || !(error instanceof BackgroundJobError) || error.code !== "lock-held" || attempt >= 99) throw error;
          await delay(25);
        }
      }
    } finally {
      release();
      if (lockTails.get(key) === tail) lockTails.delete(key);
    }
  }
  async read(id: string): Promise<SessionRuntimeRecord | undefined> {
    const record = await readJsonIfExists<SessionRuntimeRecord>(this.path(id));
    if (record !== undefined) validate(record, id);
    return record;
  }
  async create(input: CreateSessionRuntime, previousGeneration?: string): Promise<SessionRuntimeRecord> {
    const now = new Date().toISOString();
    const record: SessionRuntimeRecord = { ...input, version: 1, id: input.id ?? randomUUID(), generation: input.generation ?? randomUUID(),
      backgroundPermissionMode: input.backgroundPermissionMode ?? input.permissionMode, messages: input.messages ?? [], status: "starting", createdAt: now, updatedAt: now };
    validate(record, record.id);
    await this.lock(record.id, async () => {
      if (previousGeneration !== undefined) {
        const previous = await this.read(record.id);
        if (!previous || previous.generation !== previousGeneration ||
            !["completed", "failed", "interrupted", "cancelled"].includes(previous.status)) {
          throw new Error(`Missing, stale or active session runtime generation: ${record.id}`);
        }
        if (record.generation === previousGeneration) throw new Error("A new execution requires a fresh generation.");
        record.createdAt = previous.createdAt;
        record.title ??= previous.title;
        record.name ??= previous.name;
        record.tokenUsage ??= previous.tokenUsage;
        await writeAtomic(this.path(record.id), JSON.stringify(record, null, 2) + "\n");
      } else if (!await createExclusive(this.path(record.id), JSON.stringify(record, null, 2) + "\n")) {
        throw new Error(`Session runtime already exists: ${record.id}`);
      }
    });
    return record;
  }
  /** Existing generations only; a stale writer cannot replace another execution. */
  async save(record: SessionRuntimeRecord): Promise<void> {
    validate(record, record.id);
    await this.lock(record.id, async () => {
      const current = await this.read(record.id);
      if (!current || current.generation !== record.generation) throw new Error(`Missing or stale session runtime generation: ${record.id}`);
      record.updatedAt = new Date().toISOString();
      await writeAtomic(this.path(record.id), JSON.stringify(record, null, 2) + "\n");
    });
  }
  async update(id: string, generation: string, mutate: (record: SessionRuntimeRecord) => void | Promise<void>): Promise<SessionRuntimeRecord> {
    return this.lock(id, async () => {
      const record = await this.read(id);
      if (!record || record.generation !== generation) throw new Error(`Missing or stale session runtime generation: ${id}`);
      await mutate(record);
      if (record.id !== id || record.generation !== generation) throw new Error("Cannot change session runtime identity.");
      await this.save(record);
      return record;
    });
  }
  /** Corrupt individual entries are not discoverable as resumable sessions. Direct reads still throw. */
  async list(): Promise<SessionRuntimeRecord[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: SessionRuntimeRecord[] = [];
    for (const id of entries) {
      try { assertSessionRuntimeId(id); } catch { continue; }
      if (id === "locks") continue;
      const record = await this.read(id).catch(() => undefined);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
