import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ToolDefinition } from "../tools/types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

type Request = { id: number; method: string };
type Child = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  pid: number | undefined;
  kill: ReturnType<typeof vi.fn>;
  requests: Request[];
  callbacks: ((error?: Error | null) => void)[];
};
let tool: ToolDefinition;
let children: Child[];
let pendingMaps: Map<number, unknown>[];
const input = { path: "source/example.ts", operation: "definition" };

function reply(child: Child, id: number, payload: object = { result: null }) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, ...payload });
  child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function makeChild(autoInitialize = true): Child {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345 as number | undefined,
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: Object.assign(new EventEmitter(), { writable: true, write: vi.fn(), destroy: vi.fn() }),
    kill: vi.fn().mockImplementation(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); return true; }),
    requests: [] as Request[], callbacks: [] as Child["callbacks"],
  });
  child.stdin.write.mockImplementation((frame: string, callback?: Child["callbacks"][number]) => {
    const request = JSON.parse(frame.slice(frame.indexOf("\r\n\r\n") + 4)) as Request;
    child.requests.push(request);
    child.callbacks.push(callback ?? (() => {}));
    if (autoInitialize && request.method === "initialize") reply(child, request.id);
    return true;
  });
  children.push(child);
  return child;
}

// Observe the private pending map without exporting implementation details or
// replacing it: every request and response still goes through the public tool.
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.mocked(spawn).mockReset();
  children = [];
  pendingMaps = [];
  const set = Map.prototype.set;
  vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    if (typeof key === "string" && value?.process && value?.pending instanceof Map) pendingMaps.push(value.pending);
    return set.call(this, key, value);
  });
  vi.mocked(spawn).mockImplementation(() => makeChild() as unknown as ChildProcess);
  tool = (await import("../tools/lsp.js")).lspTool;
});

afterEach(() => {
  for (const child of children) {
    child.emit("exit", 0, null);
    child.stdout.destroy(); child.stderr.destroy();
    child.stdin.removeAllListeners(); child.removeAllListeners();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectClean() {
  expect(pendingMaps.length).toBeGreaterThan(0);
  for (const pending of pendingMaps) expect(pending.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

// Check prompt settlement without allowing the test itself to wait ten seconds.
async function promptly<T>(promise: Promise<T>): Promise<T | undefined> {
  let result: T | undefined;
  void promise.then(value => { result = value; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(result).toBeDefined();
  return result;
}

describe("LSP request lifecycle cleanup", () => {
  it.each([undefined, 0, -1, 1.5, NaN, Infinity])("never signals or escalates a failed spawn with PID %s", async (pid) => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = makeChild(false);
      child.pid = pid;
      child.kill.mockReturnValue(true); // No exit/close: exercise bounded cleanup.
      return child as unknown as ChildProcess;
    });
    const first = tool.execute(input);
    const second = tool.execute(input);
    const child = children[0]!;
    child.emit("error", new Error("spawn ENOENT"));
    expect(await promptly(Promise.all([first, second]))).toEqual([
      { output: "spawn ENOENT", isError: true }, { output: "spawn ENOENT", isError: true },
    ]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // Drainage only; no kill escalation.
    await vi.advanceTimersByTimeAsync(300);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.destroy).toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expectClean();
  });

  it("accepts buffered responses after exit without evicting a replacement", async () => {
    const first = tool.execute(input);
    const old = children[0]!;
    old.emit("exit", 0, null);
    const next = tool.execute(input);
    reply(old, 2, { result: ["buffered café"] });
    old.stdout.emit("end");
    old.emit("close", 0, null);
    expect(await first).toEqual({ output: '["buffered café"]', isError: false });
    const concurrent = tool.execute(input);
    expect(spawn).toHaveBeenCalledTimes(2);
    reply(children[1]!, 2); reply(children[1]!, 3);
    await Promise.all([next, concurrent]);
    expect(old.kill).not.toHaveBeenCalled();
    expectClean();
  });

  it.each(["end", "close", "fallback"])("rejects unanswered exited requests on %s, not on exit", async (event) => {
    const settled = vi.fn();
    const promise = tool.execute(input).then(settled);
    const child = children[0]!;
    child.emit("exit", 7, null);
    await Promise.resolve(); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    if (event === "end") child.stdout.emit("end");
    else if (event === "close") child.emit("close", 7, null);
    else await vi.advanceTimersByTimeAsync(300);
    await promise;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({ output: expect.stringMatching(/exited.*7/), isError: true });
    if (event === "end") child.emit("close", 7, null);
    expectClean();
  });

  it.each(["stdin error", "callback", "throw", "stdout error", "stderr error"])("disposes a live child on %s, escalates once, and isolates replacements", async (event) => {
    const first = tool.execute(input);
    const old = children[0]!;
    old.kill.mockReturnValue(true); // Stay alive despite SIGTERM.
    if (event === "stdin error") old.stdin.emit("error", new Error("broken transport"));
    else if (event === "stdout error") old.stdout.emit("error", new Error("broken transport"));
    else if (event === "stderr error") old.stderr.emit("error", new Error("broken transport"));
    else if (event === "callback") old.callbacks[1]!(new Error("broken transport"));
    else {
      old.stdin.write.mockImplementationOnce(() => { throw new Error("broken transport"); });
      expect(await promptly(tool.execute(input))).toEqual({ output: "broken transport", isError: true });
    }
    expect(await promptly(first)).toEqual({ output: "broken transport", isError: true });
    expect(old.kill).toHaveBeenCalledTimes(1);
    expect(old.kill).toHaveBeenCalledWith("SIGTERM");
    const next = tool.execute(input);
    old.stdin.emit("error", new Error("duplicate"));
    old.emit("error", new Error("duplicate"));
    await vi.advanceTimersByTimeAsync(150);
    expect(old.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(150);
    expect(old.stdout.destroyed).toBe(true);
    expect(old.stderr.destroyed).toBe(true);
    expect(old.stdout.listenerCount("data")).toBe(0);
    old.emit("exit", 1, null); old.emit("close", 1, null);
    const concurrent = tool.execute(input);
    expect(spawn).toHaveBeenCalledTimes(2);
    reply(children[1]!, 2); reply(children[1]!, 3);
    expect(await Promise.all([next, concurrent])).toEqual([{ output: "null", isError: false }, { output: "null", isError: false }]);
    expect(old.kill).toHaveBeenCalledTimes(2);
    expectClean();
  });
  it.each([false, true])("cleans up success/RPC error (error=%s), ignoring duplicate replies and callbacks", async (error) => {
    const promise = tool.execute(input);
    const child = children[0]!;
    reply(child, 2, error ? { error: { message: "RPC failed" } } : { result: [] });
    expect(await promise).toEqual({ output: error ? "RPC failed" : "[]", isError: error });
    expectClean();
    reply(child, 2, { error: { message: "stale" } });
    child.callbacks[1]!(new Error("late write failure"));
    const next = tool.execute(input);
    reply(child, 3);
    expect(await next).toEqual({ output: "null", isError: false });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.requests.map(r => r.method)).toEqual(["initialize", "textDocument/definition", "textDocument/definition"]);
    expectClean();
  });

  it("keeps the real 10-second timeout, removes pending, and ignores late replies", async () => {
    const settled = vi.fn();
    const promise = tool.execute(input).then(settled);
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({ output: "LSP request timed out", isError: true });
    expectClean();
    reply(children[0]!, 2);
    const next = tool.execute(input);
    reply(children[0]!, 3);
    await next;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expectClean();
  });

  it.each(["error", "exit", "stdin error"])("promptly drains concurrent requests on %s and preserves replacements on stale events", async (event) => {
    vi.mocked(spawn).mockImplementation(() => makeChild(false) as unknown as ChildProcess);
    const first = tool.execute(input);
    const second = tool.execute({ ...input, operation: "references" });
    const old = children[0]!;
    expect(old.requests.map(r => r.method)).toEqual(["initialize", "textDocument/definition", "textDocument/references"]);
    if (event === "error") old.emit("error", new Error("process failed"));
    else if (event === "stdin error") old.stdin.emit("error", new Error("pipe failed"));
    else { old.emit("exit", 7, "SIGTERM"); old.emit("close", 7, "SIGTERM"); }
    const results = await promptly(Promise.all([first, second]));
    expect(results).toEqual([
      { output: expect.stringMatching(event === "exit" ? /LSP.*exited.*7.*SIGTERM/ : event === "error" ? /process failed/ : /pipe failed/), isError: true },
      { output: expect.any(String), isError: true },
    ]);
    expectClean();
    const next = tool.execute(input);
    const replacement = children[1]!;
    old.emit("exit", 0, null);
    old.emit("error", new Error("stale error"));
    reply(old, 2);
    const concurrent = tool.execute(input);
    expect(spawn).toHaveBeenCalledTimes(2);
    reply(replacement, 1); reply(replacement, 2); reply(replacement, 3);
    expect(await Promise.all([next, concurrent])).toEqual([{ output: "null", isError: false }, { output: "null", isError: false }]);
    expectClean();
  });

  it.each(["throw", "callback"])("handles %s write failure during initialization without sending on the dead instance", async (mode) => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = makeChild(false);
      child.stdin.write.mockImplementation((_frame: string, callback?: Child["callbacks"][number]) => {
        if (mode === "throw") throw new Error("init pipe failed");
        callback?.(new Error("init pipe failed"));
        return false;
      });
      return child as unknown as ChildProcess;
    });
    expect(await promptly(tool.execute(input))).toEqual({ output: "init pipe failed", isError: true });
    expect(children[0]!.stdin.write).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expectClean();
  });

  it("drains operations when the fire-and-forget initialize write fails asynchronously", async () => {
    vi.mocked(spawn).mockImplementation(() => makeChild(false) as unknown as ChildProcess);
    const first = tool.execute(input);
    const second = tool.execute(input);
    const child = children[0]!;
    child.callbacks[0]!(new Error("async init pipe failed"));
    child.stdin.emit("error", new Error("duplicate pipe error"));
    child.emit("exit", 1, null);
    expect(await promptly(Promise.all([first, second]))).toEqual([
      { output: "async init pipe failed", isError: true }, { output: "async init pipe failed", isError: true },
    ]);
    expect(child.stdin.write).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenCalledTimes(1);
    expectClean();
  });

  it("does not write to a non-writable cached instance and drains its pending requests", async () => {
    const first = tool.execute(input);
    const child = children[0]!;
    child.stdin.writable = false;
    const second = tool.execute(input);
    expect(await promptly(Promise.all([first, second]))).toEqual([
      { output: "LSP server is not running", isError: true }, { output: "LSP server is not running", isError: true },
    ]);
    expect(child.stdin.write).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    expectClean();
  });

  it.each(["throw", "callback"])("handles %s operation write failure and drains other outstanding requests", async (mode) => {
    const first = tool.execute(input);
    const child = children[0]!;
    if (mode === "throw") child.stdin.write.mockImplementationOnce(() => { throw new Error("operation pipe failed"); });
    const second = tool.execute(input);
    if (mode === "callback") child.callbacks[2]!(new Error("operation pipe failed"));
    expect(await promptly(Promise.all([first, second]))).toEqual([
      { output: "operation pipe failed", isError: true }, { output: "operation pipe failed", isError: true },
    ]);
    expectClean();
    const next = tool.execute(input);
    child.emit("exit", 0, null);
    reply(children[1]!, 2);
    expect(await next).toEqual({ output: "null", isError: false });
    expect(spawn).toHaveBeenCalledTimes(2);
    expectClean();
  });
});
