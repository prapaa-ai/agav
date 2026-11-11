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
  it("reloads signed and redacted thinking without losing opaque replay state", async () => {
    const runtime = await create("thinking-history");
    const blocks = [
      { type: "thinking" as const, thinking: "thought", signature: "opaque-signature" },
      { type: "redacted_thinking" as const, data: "opaque-data" },
      { type: "tool_use" as const, toolCallId: "c", toolName: "lookup", toolInput: {} },
    ];
    await store.update(runtime.id, runtime.generation, current => {
      current.messages.push({ role: "assistant", content: blocks });
      current.messages.push({ role: "user", content: [{ type: "tool_result", toolCallId: "c", toolResult: "ok" }] });
    });
    expect((await loadResumableSession(runtime.id))?.messages[1]?.content).toEqual(blocks);
  });

  it("preserves legacy listing/loading when no runtime exists", async () => {
    expect(await listResumableSessions()).toEqual([saved]);
    expect(await loadResumableSession(saved.id)).toEqual(saved);
    expect(await loadResumableSession("missing")).toBeNull();
  });

  it("orders saved-only sessions by activity rather than creation", async () => {
    const old = { ...saved, updatedAt: "2024-03-01T00:00:00Z" };
    const newer = { ...saved, id: "newer", createdAt: "2024-02-01T00:00:00Z" };
    vi.mocked(listSessions).mockResolvedValue([newer, old]);
    expect((await listResumableSessions()).map(s => s.id)).toEqual([old.id, newer.id]);
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

  it("isolates a corrupt runtime transcript from healthy siblings without offering stale history", async () => {
    const bad = await create(saved.id);
    const good = await create("healthy");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(join(store.directory(bad.id), "runtime.json"), JSON.stringify({ ...bad, messages: [null] }));
    expect((await listResumableSessions()).map(record => record.id)).toEqual([good.id]);
    expect((await listResumableSessions()).map(record => record.id)).toEqual([good.id]);
    expect(warning).toHaveBeenCalledTimes(1);
    await expect(loadResumableSession(bad.id)).rejects.toThrow(/Corrupt resumable session.*shared/);
    expect(await loadResumableSession(good.id)).toMatchObject({ id: good.id, messages: good.messages });
  });

  it("isolates a session snapshot read failure during listing from healthy siblings", async () => {
    const bad = await create(saved.id);
    const good = await create("healthy");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Listing reads each runtime once via store.list() (which silently drops a
    // failing read) and a second time while building its presentation snapshot.
    // Fail only that second read for the bad session: store.list() still sees a
    // healthy record, so the failure surfaces during snapshot building, where it
    // must isolate the bad session and warn rather than hide its sibling.
    const realRead = SessionRuntimeStore.prototype.read;
    let listed = false;
    vi.spyOn(SessionRuntimeStore.prototype, "read").mockImplementation(async function (this: SessionRuntimeStore, id: string) {
      if (id === bad.id && listed) throw new Error("Session runtime read failed.");
      if (id === bad.id) listed = true;
      return realRead.call(this, id);
    });
    expect((await listResumableSessions()).map(record => record.id)).toEqual([good.id]);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("skips corrupt discovery entries but never substitutes stale history on a corrupt direct runtime read", async () => {
    const runtime = await create(saved.id);
    await writeFile(join(store.directory(runtime.id), "runtime.json"), JSON.stringify({ ...runtime, version: 2 }));
    expect(await listResumableSessions()).toEqual([saved]);
    await expect(loadResumableSession(runtime.id)).rejects.toThrow();
  });
});
