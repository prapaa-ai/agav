import { mkdtemp, rm, access, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../config/config.js";
import { deleteSession, renameSession, saveSession } from "../config/history.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { listResumableSessions, loadResumableSession } from "../sessions/history.js";
let root: string;
let store: SessionRuntimeStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-session-management-"));
  vi.spyOn(config, "getAgavDir").mockReturnValue(root);
  store = new SessionRuntimeStore();
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function runtime(status: "starting" | "running" | "needs-approval" | "completed" | "failed" | "interrupted" | "cancelled") {
  const record = await store.create({ cwd: root, provider: "anthropic", model: "mock", permissionMode: "ask", sandboxRequired: false,
    messages: [{ role: "user", content: [{ type: "text", text: "task" }] }] });
  return store.update(record.id, record.generation, current => { current.status = status; });
}
describe("detached session management", () => {
  it.each(["completed", "failed", "interrupted", "cancelled"] as const)("deletes %s runtime state and saved history", async status => {
    const record = await runtime(status);
    await saveSession(record.messages, record.model, record.provider, record.id);
    await mkdir(join(store.directory(record.id), "approvals"));
    await writeFile(join(store.directory(record.id), "approvals", "old.json"), "{}");
    expect(await deleteSession(record.id)).toBe(true);
    expect(await loadResumableSession(record.id)).toBeNull();
    expect(await listResumableSessions()).toEqual([]);
    await expect(access(store.directory(record.id))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["starting", "running", "needs-approval"] as const)("blocks deletion but allows metadata-only rename of %s", async status => {
    const record = await runtime(status);
    expect(await deleteSession(record.id)).toBe(false);
    const renamed = await renameSession(record.id, "  New name  ");
    expect(renamed).toMatchObject({ id: record.id, title: "New name", name: "New name", runtime: { generation: record.generation, status } });
    expect((await store.read(record.id))!.messages).toEqual(record.messages);
    expect(await loadResumableSession(record.id)).toMatchObject({ name: "New name", title: "New name" });
    expect(await renameSession(record.id, "   ")).toBeNull();
  });
  it("deletes terminal runtime-only sessions without a history file", async () => {
    const record = await runtime("completed");
    expect(await deleteSession(record.id)).toBe(true);
    expect(await loadResumableSession(record.id)).toBeNull();
  });
});
