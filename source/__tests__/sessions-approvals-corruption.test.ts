import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRuntimeStore } from "../sessions/store.js";
import { SessionApprovalBroker, decideSessionApproval, listPendingApprovals, type PendingSessionApproval } from "../sessions/approvals.js";
import { inputHash } from "../workflows/decisions.js";

let root: string;
let store: SessionRuntimeStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-corrupt-approvals-"));
  store = new SessionRuntimeStore(root);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function fixture(id: string) {
  const runtime = await store.create({ id, cwd: root, model: "mock", provider: "anthropic", permissionMode: "ask", sandboxRequired: false });
  const input = { path: id };
  const pending: PendingSessionApproval = { version: 1, sessionId: id, approvalId: "request", generation: runtime.generation,
    toolName: "write_file", input, inputHash: inputHash(input), createdAt: new Date().toISOString() };
  const directory = join(store.directory(id), "approvals");
  await mkdir(directory);
  await writeFile(join(directory, "request.json"), JSON.stringify(pending));
  return { runtime, pending, directory };
}

describe("corrupt approval discovery", () => {
  it.each(["pending JSON", "pending hash", "pending timestamp", "decision JSON", "decision hash"])("isolates %s without consuming consent or hiding healthy siblings", async corruption => {
    const bad = await fixture("bad");
    const good = await fixture("good");
    const decision = corruption.startsWith("decision");
    const file = join(bad.directory, decision ? "request.decided.json" : "request.json");
    const content = corruption.endsWith("JSON") ? "{broken" : JSON.stringify(decision
      ? { ...bad.pending, result: "always", inputHash: "wrong", decidedAt: new Date().toISOString() }
      : { ...bad.pending, ...(corruption.endsWith("hash") ? { inputHash: "wrong" } : { createdAt: null }) });
    await writeFile(file, content);
    expect(await listPendingApprovals(store)).toEqual([good.pending]);
    expect(await listPendingApprovals(new SessionRuntimeStore(root))).toEqual([good.pending]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toContain(file);
    // Discovery must not quarantine a corrupt decision and make it appear unanswered next time.
    expect(await readFile(file, "utf8")).toBe(content);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(decideSessionApproval(store, "bad", "request", "yes")).rejects.toThrow(/Corrupt session approval/);
    }
    expect((await store.read("good"))?.permissionMode).toBe("ask");
    expect(await listPendingApprovals(store, "good")).toEqual([good.pending]);
    await expect(readFile(join(good.directory, "request.decided.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await decideSessionApproval(store, "good", "request", "no")).record.result).toBe("no");
    await writeFile(file, "{different broken version");
    expect(await listPendingApprovals(store)).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("does not reject or autoapprove a live request because a sibling is corrupt", async () => {
    const { runtime, directory } = await fixture("live");
    await writeFile(join(directory, "request.json"), "{broken");
    const broker = new SessionApprovalBroker(store, runtime.id, runtime.generation, { pollMs: 1 });
    const settled = vi.fn();
    const waiting = broker.confirm({ toolName: "write_file", input: { path: "healthy" }, explicitApprovalOnly: true }).then(result => { settled(result); return result; });
    try {
      let approval: PendingSessionApproval | undefined;
      await vi.waitFor(async () => { [approval] = await listPendingApprovals(store, runtime.id); expect(approval?.input.path).toBe("healthy"); });
      expect(settled).not.toHaveBeenCalled();
      expect((await store.read(runtime.id))?.permissionMode).toBe("ask");
      await decideSessionApproval(store, runtime.id, approval!.approvalId, "yes");
      expect(await waiting).toBe("yes");
    } finally { broker.clear(); await waiting; }
  });
});
