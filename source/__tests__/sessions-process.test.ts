import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { AgavConfig, PermissionMode } from "../config/config.js";
import { ConversationState } from "../agent/conversation.js";
import { createSessionExecution } from "../sessions/runner.js";
import { SessionRuntimeStore } from "../sessions/store.js";
import { answerSessionApproval, readSessionSnapshot, subscribeSession, type SessionSnapshot } from "../sessions/client.js";

const fixture = fileURLToPath(new URL("./helpers/session-worker.ts", import.meta.url));
const loader = import.meta.resolve("tsx");
const config: AgavConfig = { provider: "anthropic", model: "mock", effort: "low", maxTokens: 128,
  maxIterations: 3, errorRetries: 0, permissionMode: "ask", systemPrompt: "test" };
const waits = { timeout: 10_000, interval: 25 };
async function lines(path: string): Promise<unknown[]> {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function worker(root: string, mode: PermissionMode, floor?: "ask" | "deny-writes") {
  const store = new SessionRuntimeStore(root);
  const conversation = new ConversationState();
  conversation.addUserMessage("Make one change");
  const record = await createSessionExecution(store, { ...config, permissionMode: mode }, { conversation, cwd: root });
  // Trusted loader only: no inherited execArgv, NODE_OPTIONS, credentials or real profile.
  const child = spawn(process.execPath, ["--import", loader, fixture, root, record.id, ...(floor ? [floor] : [])], {
    cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: root, USERPROFILE: root, AGAV_HOME: join(root, ".agav"), NODE_ENV: "test",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  let stdout = "", stderr = "", closed = false;
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  void exited.catch(() => {});
  async function waitExit(timeout = 10_000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Worker timeout; stdout=${stdout}; stderr=${stderr}`)), timeout);
    })]); } finally { clearTimeout(timer); }
  }
  return { record, store, child,
    async completed(allowed: boolean) {
      expect(await waitExit(), `stdout=${stdout}; stderr=${stderr}; runtime=${JSON.stringify(await store.read(record.id))}`)
        .toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ id: record.id, status: "completed", pid: child.pid });
      const snapshot = await readSessionSnapshot(record.id, new SessionRuntimeStore(root));
      expect(snapshot.record, snapshot.record.error).toMatchObject({ status: "completed", generation: record.generation, ownerPid: child.pid });
      expect(snapshot.record.ownerPid).not.toBe(process.pid);
      expect(snapshot.approvals).toEqual([]);
      const blocks = snapshot.record.messages.flatMap(message => message.content);
      expect(blocks).toContainEqual({ type: "text", text: "fixture finished" });
      expect(blocks.filter(block => block.type === "tool_result")).toEqual([
        expect.objectContaining({ toolCallId: "write-once", isError: !allowed }),
      ]);
      expect(snapshot.record.iterationsBudget).toEqual({ remaining: 1, total: 3 });
      expect((await lines(join(store.directory(record.id), "events.jsonl"))).at(-1))
        .toMatchObject({ type: "turn_complete", generation: record.generation });
      expect(await lines(join(root, "provider.jsonl"))).toEqual([{ turn: 1, pid: child.pid }, { turn: 2, pid: child.pid }]);
      expect(await lines(join(root, "effects.jsonl"))).toEqual(allowed ? [{ content: "effect", pid: child.pid }] : []);
      return snapshot.record;
    },
    async cleanup() {
      if (closed) return;
      child.kill("SIGTERM");
      try { await waitExit(5_000); } catch { child.kill("SIGKILL"); await waitExit(5_000); }
    },
  };
}

// Backend process boundary only, not the currently missing public UI detach flow.
describe("session backend in a separate worker process", () => {
  it.each(["yes", "no"] as const)("stalls in ask across observer disconnect/reconnect then consumes %s exactly once", async choice => {
    const root = await mkdtemp(join(tmpdir(), "agav-session-process-"));
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    let detach: (() => void) | undefined;
    try {
      running = await worker(root, "ask");
      const { record, store, child } = running;
      let observed: SessionSnapshot | undefined;
      const errors: Error[] = [];
      const onSnapshot = vi.fn((snapshot: SessionSnapshot) => { observed = snapshot; });
      const callbacks = { onSnapshot, onError: (error: Error) => errors.push(error) };
      detach = subscribeSession(record.id, callbacks, { store, intervalMs: 10 });
      await vi.waitFor(() => {
        expect(observed?.record.status).toBe("needs-approval");
        expect(observed?.approvals).toHaveLength(1);
      }, waits);
      const approval = observed!.approvals[0]!;
      expect(approval).toMatchObject({ sessionId: record.id, generation: record.generation, toolName: "test_write", input: { content: "effect" } });
      detach(); detach = undefined;
      const count = onSnapshot.mock.calls.length;
      await delay(250); // More than one broker poll with no observer attached.
      expect(onSnapshot).toHaveBeenCalledTimes(count);
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
      const reconnect = new SessionRuntimeStore(root);
      expect(await readSessionSnapshot(record.id, reconnect)).toMatchObject({ record: { status: "needs-approval", ownerPid: child.pid }, approvals: [approval] });
      expect(await lines(join(root, "effects.jsonl"))).toEqual([]);
      expect(await lines(join(root, "provider.jsonl"))).toEqual([{ turn: 1, pid: child.pid }]);
      const decisionPath = join(store.directory(record.id), "approvals", `${approval.approvalId}.decided.json`);
      await expect(readFile(decisionPath)).rejects.toMatchObject({ code: "ENOENT" });
      observed = undefined;
      detach = subscribeSession(record.id, callbacks, { store: reconnect, intervalMs: 10 });
      await vi.waitFor(() => expect(observed?.approvals).toEqual([approval]), waits);
      await expect(answerSessionApproval(record.id, { ...approval, generation: "stale" }, choice, reconnect)).rejects.toThrow(/stale/);
      await expect(answerSessionApproval(record.id, { ...approval, inputHash: "wrong" }, choice, reconnect)).rejects.toThrow(/stale/);
      const decision = await answerSessionApproval(record.id, approval, choice, reconnect);
      expect(decision).toMatchObject({ won: true, record: { result: choice, generation: record.generation, inputHash: approval.inputHash } });
      const result = await running.completed(choice === "yes");
      await vi.waitFor(() => expect(observed?.record.status).toBe("completed"), waits);
      expect(JSON.parse(await readFile(decisionPath, "utf8"))).toEqual(decision.record);
      await expect(answerSessionApproval(record.id, approval, choice, new SessionRuntimeStore(root))).rejects.toThrow(/stale/);
      expect((await readSessionSnapshot(record.id, new SessionRuntimeStore(root))).record).toEqual(result);
      expect(await lines(join(root, "effects.jsonl"))).toHaveLength(choice === "yes" ? 1 : 0);
      expect(errors).toEqual([]);
    } finally {
      detach?.();
      try { await running?.cleanup(); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    }
  }, 20_000);

  it.each([
    { mode: "auto-accept", allowed: true }, { mode: "deny-writes", allowed: false },
    { mode: "auto-accept", floor: "deny-writes", allowed: false },
  ] as const)("honors stored $mode and stricter $floor without an observer", async test => {
    const root = await mkdtemp(join(tmpdir(), "agav-session-process-policy-"));
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      const floor = "floor" in test ? test.floor : undefined;
      running = await worker(root, test.mode, floor);
      const result = await running.completed(test.allowed);
      expect(result.permissionMode).toBe(floor ?? test.mode);
      if (floor) expect(result.permissionFloor).toBe(floor);
      await expect(readdir(join(running.store.directory(result.id), "approvals"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try { await running?.cleanup(); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    }
  }, 20_000);

  it("tightens stored auto-accept to ask under a new worker policy floor", async () => {
    const root = await mkdtemp(join(tmpdir(), "agav-session-process-floor-"));
    let running: Awaited<ReturnType<typeof worker>> | undefined;
    try {
      running = await worker(root, "auto-accept", "ask");
      const { record } = running;
      const store = new SessionRuntimeStore(root);
      await vi.waitFor(async () => {
        const snapshot = await readSessionSnapshot(record.id, store);
        expect(snapshot.record).toMatchObject({ status: "needs-approval", permissionMode: "ask", permissionFloor: "ask" });
        expect(snapshot.approvals).toHaveLength(1);
      }, waits);
      const [approval] = (await readSessionSnapshot(record.id, store)).approvals;
      expect(await lines(join(root, "effects.jsonl"))).toEqual([]);
      expect((await answerSessionApproval(record.id, approval!, "always", store)).record.result).toBe("yes");
      expect((await running.completed(true)).permissionMode).toBe("ask");
    } finally {
      try { await running?.cleanup(); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    }
  }, 20_000);
});
