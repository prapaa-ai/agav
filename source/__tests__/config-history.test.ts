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

  it("updates terminal runtime tokens but never overwrites an active runtime", async () => {
    const record = await create();
    await saveSession([], "local", "openai", record.id, { ...tokens, outputTokens: 30 });
    expect(await store.read(record.id)).toEqual(record);
    await store.update(record.id, record.generation, current => { current.status = "completed"; });
    await saveSession([], "local", "openai", record.id, { ...tokens, outputTokens: 30 }, true, "Local name");
    expect(await store.read(record.id)).toMatchObject({ messages: [], model: "local", provider: "openai", tokenUsage: { ...tokens, outputTokens: 30 }, compacted: true, name: "Local name" });
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
