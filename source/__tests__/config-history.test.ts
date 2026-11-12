import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../config/config.js";
import { deleteSession, listSessions, loadSession, renameSession, saveSession, saveSessionRuntime } from "../config/history.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import type { Message } from "../providers/types.js";

let root: string;
let store: SessionRuntimeStore;
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Worker question" }] }];
const tokens = { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-config-history-"));
  vi.spyOn(config, "getAgavDir").mockReturnValue(root);
  store = new SessionRuntimeStore();
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const create = () => store.create({ cwd: root, model: "worker-model", provider: "anthropic", permissionMode: "ask", sandboxRequired: false, messages, tokenUsage: tokens });

describe("history persistence", () => {
  it("supports legacy dotted ids without reading or locking the runtime store", async () => {
    const read = vi.spyOn(SessionRuntimeStore.prototype, "read");
    const lock = vi.spyOn(SessionRuntimeStore.prototype, "lock");
    await saveSession(messages, "legacy", "provider", "legacy.session.1");
    expect(await loadSession("legacy.session.1")).toMatchObject({ model: "legacy" });
    expect(await renameSession("legacy.session.1", "Renamed")).toMatchObject({ name: "Renamed" });
    expect(await deleteSession("legacy.session.1")).toBe(true);
    expect(await deleteSession("legacy.session.1")).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it("rejects traversal instead of accessing files outside history", async () => {
    await expect(saveSession(messages, "model", "provider", "../escaped")).rejects.toThrow(/Invalid/);
    await expect(deleteSession("../escaped")).rejects.toThrow(/Invalid/);
    expect(await loadSession("../escaped")).toBeNull();
  });

  it("mirrors active worker snapshots for ordinary history list/load callers without changing runtime", async () => {
    const record = await create();
    await saveSessionRuntime(record);
    expect(await loadSession(record.id)).toMatchObject({ messages, tokenUsage: tokens, model: record.model });
    expect(await listSessions()).toEqual([await loadSession(record.id)]);
    expect(await store.read(record.id)).toEqual(record);
    const next = await store.update(record.id, record.generation, current => { current.messages = []; current.tokenUsage = { ...tokens, outputTokens: 9 }; });
    await saveSessionRuntime(next);
    expect(await loadSession(record.id)).toMatchObject({ messages: [], tokenUsage: { ...tokens, outputTokens: 9 } });
    expect(await store.read(record.id)).toEqual(next);
  });

  it("keeps renamed metadata and parent lineage across worker checkpoints and generations", async () => {
    const record = await create();
    // Seed ordinary saved metadata before this execution becomes worker-owned.
    await store.update(record.id, record.generation, current => { current.status = "completed"; });
    await saveSession(messages, record.model, record.provider, record.id, tokens, undefined, "Original", "parent");
    await store.update(record.id, record.generation, current => { current.status = "running"; });
    await renameSession(record.id, "New name");
    await saveSessionRuntime(record);
    expect(await loadSession(record.id)).toMatchObject({ title: "New name", name: "New name", parentId: "parent", tokenUsage: tokens });
    expect(await store.read(record.id)).toMatchObject({ title: "New name", name: "New name" });
    await store.update(record.id, record.generation, current => { current.status = "completed"; });
    const next = await store.create({ id: record.id, cwd: root, model: record.model, provider: record.provider, permissionMode: "ask", sandboxRequired: false }, record.generation);
    expect(next).toMatchObject({ name: "New name", tokenUsage: tokens });
    await expect(saveSessionRuntime(record)).rejects.toThrow(/stale/);
    expect(await loadSession(record.id)).toMatchObject({ name: "New name" });
  });

  it.each([false, true])("returns updated runtime metadata after rename (saved history: %s)", async (withHistory) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const record = await create();
      if (withHistory) {
        await saveSessionRuntime(record);
        const saved = await loadSession(record.id);
        await writeFile(join(root, "history", `${record.id}.json`), JSON.stringify({
          ...saved, updatedAt: record.updatedAt, cwd: "stale-project",
        }));
      }
      vi.setSystemTime(new Date("2024-01-02T00:00:00Z"));
      const renamed = await renameSession(record.id, " New name ");
      const updated = await store.read(record.id);
      expect(updated!.updatedAt).not.toBe(record.updatedAt);
      expect(renamed).toMatchObject({
        title: "New name", name: "New name", createdAt: record.createdAt,
        updatedAt: updated!.updatedAt, cwd: updated!.cwd,
        messages, tokenUsage: tokens,
        runtime: { generation: record.generation, status: record.status, pendingCount: 0, cwd: root },
      });
      expect(await loadSession(record.id)).toEqual(withHistory
        ? expect.objectContaining({ title: "New name", name: "New name" })
        : null);
    } finally { vi.useRealTimers(); }
  });

  it("updates terminal runtime tokens but never overwrites an active runtime", async () => {
    const record = await create();
    await saveSession([], "local", "openai", record.id, { ...tokens, outputTokens: 30 });
    expect(await store.read(record.id)).toEqual(record);
    await store.update(record.id, record.generation, current => { current.status = "completed"; });
    await saveSession([], "local", "openai", record.id, { ...tokens, outputTokens: 30 }, true, "Local name");
    expect(await store.read(record.id)).toMatchObject({ messages: [], model: "local", provider: "openai", tokenUsage: { ...tokens, outputTokens: 30 }, compacted: true, name: "Local name" });
  });

  it("preserves runtime permissions across local saves and worker history mirrors", async () => {
    const record = await create();
    await store.update(record.id, record.generation, current => { current.status = "completed"; current.permissionMode = "deny-writes"; });
    await saveSession(messages, record.model, record.provider, record.id);
    expect((await loadSession(record.id))!.permissionMode).toBe("deny-writes");
    await saveSession(messages, record.model, record.provider, record.id, undefined, undefined, undefined, undefined, "ask");
    expect((await store.read(record.id))!.permissionMode).toBe("ask");
    expect((await loadSession(record.id))!.permissionMode).toBe("ask");
    await store.update(record.id, record.generation, current => { current.status = "running"; current.permissionMode = "deny-writes"; });
    await saveSession(messages, "stale", "openai", record.id, undefined, undefined, undefined, undefined, "auto-accept");
    expect((await store.read(record.id))!.permissionMode).toBe("deny-writes");
    await saveSessionRuntime(record); // Even a stale checkpoint must use the current mode.
    expect((await loadSession(record.id))!.permissionMode).toBe("deny-writes");
  });

  it("fences worker checkpoints after deletion", async () => {
    const record = await create();
    await store.update(record.id, record.generation, current => { current.status = "completed"; });
    expect(await deleteSession(record.id)).toBe(true);
    await expect(saveSessionRuntime(record)).rejects.toThrow(/Missing|stale/);
    expect(await loadSession(record.id)).toBeNull();
  });
});

describe("history deletion failures", () => {
  it("returns false only for absent or active sessions", async () => {
    expect(await deleteSession("missing")).toBe(false);
    const record = await create();
    expect(await deleteSession(record.id)).toBe(false);
  });
  it("propagates lock failures", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(SessionRuntimeStore.prototype, "lock").mockRejectedValueOnce(error);
    await expect(deleteSession("locked")).rejects.toBe(error);
  });
  it("propagates corrupt runtime failures", async () => {
    const record = await create();
    await writeFile(join(store.directory(record.id), "runtime.json"), "not JSON");
    await expect(deleteSession(record.id)).rejects.toThrow(/Corrupt/);
  });
  it("propagates history unlink failures", async () => {
    await mkdir(join(root, "history", "directory.json"), { recursive: true });
    await expect(deleteSession("directory")).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EPERM/) });
  });
});

it("keeps creation time separate from activity across saves and renames", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const id = await saveSession(messages, "model", "openai");
    const first = await loadSession(id);
    vi.setSystemTime(new Date("2024-02-01T00:00:00Z"));
    await saveSession(messages, "model", "openai", id);
    expect(await loadSession(id)).toMatchObject({ createdAt: first!.createdAt, updatedAt: "2024-02-01T00:00:00.000Z" });
    const newer = await saveSession(messages, "model", "openai");
    vi.setSystemTime(new Date("2024-03-01T00:00:00Z"));
    expect(await renameSession(id, "Renamed")).toMatchObject({ createdAt: first!.createdAt, updatedAt: "2024-03-01T00:00:00.000Z" });
    expect((await listSessions()).map(s => s.id)).toEqual([id, newer]);
  } finally { vi.useRealTimers(); }
});

it.each(["save", "rename"] as const)("preserves legacy timestamp history on %s", async operation => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const now = "2026-01-01T00:00:00.000Z";
    const oldUpdatedAt = "2024-06-01T00:00:00.000Z";
    const oldCreatedAt = "2024-01-01T00:00:00.000Z";
    vi.setSystemTime(new Date(now));
    await mkdir(join(root, "history"), { recursive: true });
    for (const [index, timestamps] of [
      { updatedAt: oldUpdatedAt },
      { createdAt: oldCreatedAt, updatedAt: oldUpdatedAt },
      { createdAt: oldCreatedAt },
      {},
    ].entries()) {
      const id = `legacy-${index}`;
      const createdAt = timestamps.createdAt ?? timestamps.updatedAt ?? now;
      await writeFile(join(root, "history", `${id}.json`), JSON.stringify({
        id, title: "Legacy", model: "model", provider: "openai", messages, ...timestamps,
      }));
      if (operation === "save") await saveSession(messages, "model", "openai", id);
      else expect(await renameSession(id, "Renamed")).toMatchObject({ createdAt, updatedAt: now });
      expect(await loadSession(id)).toMatchObject({ createdAt, updatedAt: now });
      // Subsequent updates must retain the recovered date, not the new activity date.
      vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
      await saveSession(messages, "model", "openai", id);
      expect(await loadSession(id)).toMatchObject({ createdAt, updatedAt: "2026-02-01T00:00:00.000Z" });
      vi.setSystemTime(new Date(now));
    }
  } finally { vi.useRealTimers(); }
});

it("preserves the original creation time when a resumed runtime mirrors history", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // A session created long ago and saved to history.
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const original = await create();
    await saveSessionRuntime(original);
    const before = await loadSession(original.id);
    expect(before!.createdAt).toBe("2024-01-01T00:00:00.000Z");

    // Resume much later: a fresh runtime whose own createdAt is "now".
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    await store.update(original.id, original.generation, current => { current.status = "completed"; });
    const resumed = await store.create({ id: original.id, cwd: root, model: "worker-model", provider: "anthropic",
      permissionMode: "ask", sandboxRequired: false, messages }, original.generation);
    const active = await store.update(resumed.id, resumed.generation, current => { current.status = "running"; });
    await saveSessionRuntime(active);

    const after = await loadSession(original.id);
    // Creation date stays put; only activity advances. Sort-by-created restores order.
    expect(after!.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(after!.updatedAt).toBe(active.updatedAt);
  } finally { vi.useRealTimers(); }
});

it("preserves history creation time when a saved-only session first gets a runtime", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const id = await saveSession(messages, "model", "openai");
    const before = await loadSession(id);
    expect(before!.createdAt).toBe("2024-01-01T00:00:00.000Z");

    // Later this saved-only session is resumed, creating its first runtime.
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const runtime = await store.create({ id, cwd: root, model: "model", provider: "openai",
      permissionMode: "ask", sandboxRequired: false, messages });
    const active = await store.update(runtime.id, runtime.generation, current => { current.status = "running"; });
    await saveSessionRuntime(active);

    const after = await loadSession(id);
    expect(after!.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(after!.updatedAt).toBe(active.updatedAt);
  } finally { vi.useRealTimers(); }
});

it.each([
  { createdAt: "2024-01-01T00:00:00.000Z" },
  { createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-02-01T00:00:00.000Z" },
  { updatedAt: "2024-01-01T00:00:00.000Z" },
])("preserves legacy creation in the resume view across first runtime, checkpoints, rename and local save: %j", async timestamps => {
  const { listResumableSessions, loadResumableSession } = await import("../sessions/history.js");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const createdAt = timestamps.createdAt ?? timestamps.updatedAt;
    const id = "legacy-first-runtime";
    await mkdir(join(root, "history"), { recursive: true });
    await writeFile(join(root, "history", id + ".json"), JSON.stringify({
      id, title: "Legacy", model: "model", provider: "openai", messages, ...timestamps,
    }));
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const newerId = await saveSession(messages, "model", "openai");
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const runtime = await store.create({ id, cwd: root, model: "model", provider: "openai",
      permissionMode: "ask", sandboxRequired: false, messages });
    expect(runtime.createdAt).not.toBe(createdAt);
    const checkView = async () => {
      const current = (await store.read(id))!;
      expect(await loadResumableSession(id)).toMatchObject({ createdAt, updatedAt: current.updatedAt, messages: current.messages });
      const listed = await listResumableSessions();
      expect(listed.map(s => s.id)).toEqual([id, newerId]);
      expect(listed.find(s => s.id === id)).toMatchObject({ createdAt, updatedAt: current.updatedAt });
      expect(listed.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(s => s.id)).toEqual([newerId, id]);
    };
    await checkView();
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    const active = await store.update(id, runtime.generation, current => {
      current.status = "running";
      current.messages = [...messages, { role: "user", content: [{ type: "text", text: "Resumed message" }] }];
    });
    await saveSessionRuntime(active);
    expect(await loadSession(id)).toMatchObject({ createdAt, updatedAt: active.updatedAt });
    await checkView();
    expect(await renameSession(id, "Renamed")).toMatchObject({ createdAt });
    await checkView();
    await store.update(id, runtime.generation, current => { current.status = "completed"; });
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    await saveSession(active.messages, "model", "openai", id);
    expect(await loadSession(id)).toMatchObject({ createdAt, updatedAt: "2026-03-01T00:00:00.000Z" });
    await checkView();
  } finally { vi.useRealTimers(); }
});

it("persists signed prefix provenance through saved history and worker checkpoints", async () => {
  const { ConversationState } = await import("../agent/conversation.js");
  const conversation = new ConversationState(true);
  conversation.addUserMessage("task");
  conversation.prepareThinkingPrefix("original-prefix");
  conversation.addAssistantMessage([
    { type: "thinking", thinking: "opaque", signature: "signed" },
    { type: "redacted_thinking", data: "encrypted" },
    { type: "tool_use", toolCallId: "c", toolName: "read_file", toolInput: {} },
  ]);
  conversation.addToolResults([{ type: "tool_result", toolCallId: "c", toolResult: "completed action" }]);
  const original = structuredClone(conversation.getMessages());
  const id = await saveSession(original, "claude-opus-5-5", "anthropic");
  const saved = await loadSession(id);
  expect(saved?.messages).toEqual(original);
  const runtime = await store.create({ cwd: root, model: "claude-opus-5-5", provider: "anthropic",
    permissionMode: "ask", sandboxRequired: false, messages: saved!.messages });
  await saveSessionRuntime(runtime);
  const checkpoint = await loadSession(runtime.id);
  expect(checkpoint?.messages).toEqual(original);
  const restored = new ConversationState(true);
  restored.setMessages(checkpoint!.messages);
  restored.prepareThinkingPrefix("original-prefix");
  expect(restored.getMessages()).toEqual(original);
  restored.prepareThinkingPrefix("refreshed-instructions-or-tools");
  expect(restored.getMessages().flatMap(m => m.content).every(b => b.type === "text")).toBe(true);
  expect(JSON.stringify(restored.getMessages())).toContain("completed action");
  expect(restored.getTranscript()).toEqual(original);
});
