import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const children: ChildProcess[] = [];
const input = { path: "source/example.ts", operation: "definition" };
beforeEach(() => { vi.resetModules(); vi.mocked(spawn).mockReset(); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  }
  vi.restoreAllMocks();
});

async function useChild(script: string, pause = false) {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const child = actual.spawn(process.execPath, ["-e", script], { stdio: "pipe" });
  children.push(child);
  vi.mocked(spawn).mockReturnValue(child);
  if (pause) {
    child.stdout!.pause();
    child.once("exit", () => setImmediate(() => child.stdout!.resume()));
  }
  const closed = once(child, "close");
  const tool = (await import("../tools/lsp.js")).lspTool;
  return { child, closed, tool };
}

it("survives a real nonexistent-executable spawn in an isolated process group", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "agav-lsp-failed-spawn-"));
  let child: ChildProcess | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Detach the caller, not the failed child: a PID-less kill must never reach
    // the test runner's process group, even when this regression fails.
    child = actual.spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const spawn = childProcess.spawn;
      let kills = 0;
      let failed;
      childProcess.spawn = (...args) => {
        failed = spawn(${JSON.stringify(join(directory, "nonexistent-language-server"))}, args[1], args[2]);
        assert.equal(failed.pid, undefined);
        const kill = failed.kill.bind(failed);
        failed.kill = (...args) => { kills++; return kill(...args); };
        return failed;
      };
      syncBuiltinESMExports();
      const { lspTool } = await import(${JSON.stringify(new URL("../tools/lsp.ts", import.meta.url).href)});
      const result = await lspTool.execute(${JSON.stringify(input)});
      assert.equal(result.isError, true);
      assert.match(result.output, /ENOENT|EPIPE|not running/);
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(kills, 0);
      assert.equal(failed.stdin.destroyed, true);
      assert.equal(failed.stdout.destroyed, true);
      assert.equal(failed.stderr.destroyed, true);
      assert.equal(failed.stdout.listenerCount('data'), 0);
      console.log('failed-spawn cleanup survived');
    `], { detached: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const closed = once(child, "close");
    timeout = setTimeout(() => { child!.kill("SIGKILL"); }, 5000);
    const [code, signal] = await closed;
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
    expect(stdout.trim()).toBe("failed-spawn cleanup survived");
  } finally {
    clearTimeout(timeout);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it("drains real Node stdout buffered until after process exit", async () => {
  const { child, closed, tool } = await useChild(`
    process.stdin.once('data', () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 2, result: ['café 中 😀'] });
      process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body, () => process.exit(0));
    });
  `, true);
  const order: string[] = [];
  child.once("exit", () => order.push("exit"));
  child.stdout!.on("data", () => order.push("data"));
  expect(await tool.execute(input)).toEqual({ output: '["café 中 😀"]', isError: false });
  await closed;
  expect(order.indexOf("exit")).toBeLessThan(order.indexOf("data"));
  expect(child.stdout!.destroyed).toBe(true);
});

it("rejects an unanswered request when a real process closes", async () => {
  const { closed, tool } = await useChild("process.stdin.once('data', () => process.exit(7));", true);
  expect(await tool.execute(input)).toEqual({ output: expect.stringMatching(/exited.*7|stdout ended/), isError: true });
  await closed;
});

it.skipIf(process.platform === "win32")("terminates a real live child that ignores SIGTERM after a write callback failure", async () => {
  const { child, closed, tool } = await useChild(`
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `);
  await once(child.stdout!, "data");
  const kill = vi.spyOn(child, "kill");
  vi.spyOn(child.stdin!, "write").mockImplementationOnce((_chunk: unknown, callback: any) => {
    callback(new Error("broken live stdin"));
    return false;
  });
  expect(await tool.execute(input)).toEqual({ output: "broken live stdin", isError: true });
  await closed;
  expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(child.signalCode).toBe("SIGKILL");
  expect(child.stdin!.destroyed).toBe(true);
  expect(child.stdout!.destroyed).toBe(true);
  expect(child.stderr!.destroyed).toBe(true);
  expect(child.stdout!.listenerCount("data")).toBe(0);
});
