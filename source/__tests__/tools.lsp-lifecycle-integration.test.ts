import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

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
