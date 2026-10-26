import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../config/config.js";
import { listSessions, loadSession, type SessionRecord } from "../config/history.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { SessionApprovalBroker } from "../sessions/approvals.js";
import { listResumableSessions, loadResumableSession } from "../sessions/history.js";

vi.mock("../config/history.js", () => ({ listSessions: vi.fn(), loadSession: vi.fn() }));
let root: string;
let store: SessionRuntimeStore;
const saved: SessionRecord = { id: "shared", title: "Saved name", name: "Saved name", createdAt: "2024-01-01T00:00:00Z",
  model: "old", provider: "anthropic", messages: [], tokenUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-resumable-"));
  vi.spyOn(config, "getAgavDir").mockReturnValue(root);
  store = new SessionRuntimeStore();
  vi.mocked(listSessions).mockResolvedValue([saved]);
  vi.mocked(loadSession).mockImplementation(async id => id === saved.id ? saved : null);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const create = (id: string) => store.create({ id, cwd: root, model: "live", provider: "openai", permissionMode: "ask", sandboxRequired: false,
  messages: [{ role: "user", content: [{ type: "text", text: "Live question" }] }] });

describe("resumable history", () => {
  it("preserves legacy listing/loading when no runtime exists", async () => {
    expect(await listResumableSessions()).toEqual([saved]);
    expect(await loadResumableSession(saved.id)).toEqual(saved);
    expect(await loadResumableSession("missing")).toBeNull();
  });

  it("merges by id with runtime settings and transcript winning, retaining saved metadata", async () => {
    const runtime = await create(saved.id);
    const [record] = await listResumableSessions();
    expect(record).toMatchObject({ id: saved.id, model: "live", provider: "openai", title: saved.title, name: saved.name,
      tokenUsage: saved.tokenUsage, messages: runtime.messages,
      runtime: { generation: runtime.generation, status: "starting", pendingCount: 0, cwd: root } });
    await store.update(runtime.id, runtime.generation, current => { current.messages = []; current.status = "completed"; });
    expect(await loadResumableSession(saved.id)).toMatchObject({ messages: [], runtime: { status: "completed" } });
  });

  it("discovers runtime-only sessions before history save and counts outstanding approvals", async () => {
    const runtime = await create("runtime-only");
    const broker = new SessionApprovalBroker(store, runtime.id, runtime.generation, { pollMs: 1 });
    const waiting = broker.confirm({ toolName: "write_file", input: { path: "test" } });
    try {
      await vi.waitFor(async () => {
        expect(await loadResumableSession(runtime.id)).toMatchObject({ title: "Live question", runtime: { status: "needs-approval", pendingCount: 1 } });
      });
      expect((await listResumableSessions()).map(record => record.id)).toEqual([runtime.id, saved.id]);
    } finally { broker.clear(); await waiting; }
    expect(await loadResumableSession(runtime.id)).toMatchObject({ runtime: { pendingCount: 0 } });
  });

  it("skips corrupt discovery entries but never substitutes stale history on a corrupt direct runtime read", async () => {
    const runtime = await create(saved.id);
    await writeFile(join(store.directory(runtime.id), "runtime.json"), JSON.stringify({ ...runtime, version: 2 }));
    expect(await listResumableSessions()).toEqual([saved]);
    await expect(loadResumableSession(runtime.id)).rejects.toThrow();
  });
});
