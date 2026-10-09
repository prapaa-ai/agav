import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/temp-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/temp-output.js")>();
  const { isolatedTempOutputManager } = await import("./helpers/temp-output.js");
  return { ...actual, tempOutputManager: await isolatedTempOutputManager(actual.TempOutputManager) };
});
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { TempOutputManager, MAX_SAVED_OUTPUT_BYTES, tempOutputManager } from "../utils/temp-output.js";
import { boundToolResult } from "../utils/tool-output.js";
import { fileReadTool } from "../tools/file-read.js";
import { shellTool } from "../tools/shell.js";
import { fetchUrlTool } from "../tools/fetch-url.js";
import { ToolRegistry } from "../tools/registry.js";

const roots: string[] = [];
const managers: TempOutputManager[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "agav-output-test-"));
  roots.push(path);
  return path;
}
function manager(path = root(), budget = 100, slots = 4): TempOutputManager {
  const result = new TempOutputManager(path, budget, slots, 1000);
  managers.push(result);
  return result;
}
function seed(path: string, slot: number, pid: number, created = Date.now() - 2000): string {
  const directory = join(path, `slot-${slot}`);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "owner.json"), JSON.stringify({ version: 1, slot, pid, created }), { mode: 0o600 });
  writeFileSync(join(directory, "sentinel"), "keep");
  return directory;
}
afterEach(() => {
  vi.restoreAllMocks();
  managers.splice(0).forEach((value) => value.cleanup());
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("shared temporary output retention", () => {
  it("reserves pending writers and keeps published files until shutdown without eviction", () => {
    const store = manager();
    const first = store.create(60);
    expect(() => store.create(41)).toThrow("quota");
    const second = store.create(40);
    first.write(Buffer.from("hello"));
    const path = first.publish();
    expect(readdirSync(dirname(path))).toEqual(["output.log"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const third = store.create(55);
    expect(() => store.create(1)).toThrow("quota");
    second.discard(); third.discard();
    expect(readFileSync(path, "utf8")).toBe("hello");
    store.cleanup(); store.cleanup();
    expect(existsSync(path)).toBe(false);
    expect(() => store.create(1)).toThrow();
    expect(() => second.write(Buffer.from("x"))).toThrow();
  });

  it("caps Unicode logs at the file limit and labels partial capture", () => {
    const store = manager();
    const capture = store.create(5);
    capture.write(Buffer.from("😀é"));
    capture.write(Buffer.from("ignored"));
    expect(capture.partial).toBe(true);
    const path = capture.publish();
    expect(statSync(path).size).toBe(4);
    expect(readFileSync(path, "utf8")).toBe("😀");
  });

  it("atomically admits isolated sessions, refuses root quota, and cleans only its own", () => {
    const path = root();
    const a = manager(path, 100, 2);
    const b = manager(path, 100, 2);
    const logA = a.create(10); logA.write(Buffer.from("A"));
    const pathA = logA.publish();
    const logB = b.create(10); logB.write(Buffer.from("B"));
    const pathB = logB.publish();
    expect(pathA).not.toBe(pathB);
    expect(() => manager(path, 100, 2).create(10)).toThrow("root reservation quota");
    a.cleanup();
    expect(existsSync(pathA)).toBe(false);
    expect(readFileSync(pathB, "utf8")).toBe("B");
    manager(path, 100, 2).create(10).discard();
  });

  it("prunes TTL-expired dead owners but protects recent crashes and arbitrarily old live PIDs", () => {
    const path = root();
    const old = seed(path, 0, 99999999);
    const live = seed(path, 1, process.pid, 1);
    const recent = seed(path, 2, 99999999, Date.now());
    const capture = manager(path).create(1);
    capture.discard();
    expect(existsSync(join(old, "sentinel"))).toBe(false);
    expect(existsSync(join(live, "sentinel"))).toBe(true);
    expect(existsSync(join(recent, "sentinel"))).toBe(true);
  });

  it("does not prune denied PID probes or reused live PIDs", () => {
    const path = root();
    const protectedPath = seed(path, 0, 12345, 1);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    manager(path).create(1).discard();
    expect(existsSync(join(protectedPath, "sentinel"))).toBe(true);
  });

  it("never follows slot/owner symlinks or deletes arbitrary root entries", () => {
    const path = root();
    const outside = root();
    writeFileSync(join(outside, "sentinel"), "safe");
    symlinkSync(outside, join(path, "slot-0"), "dir");
    mkdirSync(join(path, "slot-1"), { mode: 0o700 });
    writeFileSync(join(outside, "owner.json"), JSON.stringify({ version: 1, slot: 1, pid: 99999999, created: 1 }));
    symlinkSync(join(outside, "owner.json"), join(path, "slot-1", "owner.json"));
    mkdirSync(join(path, "arbitrary"));
    manager(path).create(1).discard();
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("safe");
    expect(existsSync(join(path, "slot-1", "owner.json"))).toBe(true);
    expect(existsSync(join(path, "arbitrary"))).toBe(true);
  });

  it("fails closed for unsafe roots, invalid metadata, and abandoned pruning locks", () => {
    const outside = root();
    const path = root();
    const link = join(path, "link");
    symlinkSync(outside, link, "dir");
    expect(() => manager(link).create(1)).toThrow("Unsafe");
    if (process.platform !== "win32") {
      chmodSync(outside, 0o755);
      expect(() => manager(outside).create(1)).toThrow("Unsafe");
    }
    const unknown = seed(path, 0, 99999999, 1);
    writeFileSync(join(unknown, "owner.json"), "invalid");
    const locked = seed(path, 1, 99999999, 1);
    mkdirSync(join(locked, "prune.lock"), { mode: 0o700 });
    manager(path).create(1).discard();
    expect(existsSync(join(unknown, "sentinel"))).toBe(true);
    expect(existsSync(join(locked, "sentinel"))).toBe(true);
  });

  it("generic capture caps storage, preserves errors and supports subsequent read_file", async () => {
    const text = "HEAD\n" + "😀".repeat(MAX_SAVED_OUTPUT_BYTES / 4) + "\nTAIL";
    const result = await boundToolResult({ output: text, isError: true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Partial returned text (16 MiB storage limit)");
    expect(result.output).toContain("remaining omitted content is unavailable");
    expect(result.output).toContain("TAIL");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40000);
    const match = result.output.match(/storage limit\): ("(?:[^"\\]|\\.)*")/)!;
    const path = JSON.parse(match[1]) as string;
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_SAVED_OUTPUT_BYTES);
    expect(readFileSync(path, "utf8")).not.toContain("�");
    expect((await fileReadTool.execute({ path, start_line: 1, end_line: 1 })).output).toContain("HEAD");
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it("quota refusal preserves status and never repeats side effects", async () => {
    vi.spyOn(tempOutputManager, "create").mockImplementation(() => { throw new Error("Temporary output process retention quota reached"); });
    const result = await boundToolResult({ output: "x".repeat(50000), isError: false });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("retention quota reached");
    expect(result.output).toContain("unavailable");
    expect(result.output).not.toContain("Complete returned text:");
    const execute = vi.fn(async () => ({ output: "x".repeat(50000), isError: true }));
    const registry = new ToolRegistry();
    registry.register({ schema: { name: "side-effect", description: "", inputSchema: {} }, execute });
    expect((await registry.execute("side-effect", {})).isError).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    vi.stubEnv("AGAV_NO_SANDBOX", "1");
    const shell = await shellTool.execute({ command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(50000)); process.exitCode = 7"`, sandbox: "none" });
    vi.unstubAllEnvs();
    expect(shell.isError).toBe(true);
    expect(shell.output).toContain("retention quota reached");
    expect(shell.output).toContain("Command exited with code 7");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(50000)));
    const http = await fetchUrlTool.execute({ url: "https://example.test/" });
    expect(http.isError).toBe(false);
    expect(http.output).toContain("retention quota reached");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("coordinates admission and isolation across actual concurrent processes", async () => {
    const path = root();
    const code = `import { TempOutputManager } from './source/utils/temp-output.ts';
      const store = new TempOutputManager(${JSON.stringify(path)}, 100, 2, 1000);
      const capture = store.create(10); capture.write(Buffer.from(String(process.pid)));
      console.log(capture.publish());
      process.stdin.once('data', () => { store.cleanup(); process.exit(0); });`;
    const children = [1, 2].map(() => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code]));
    try {
      const paths = await Promise.all(children.map((child) => new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (data) => resolve(String(data).trim()));
        child.stderr.once("data", (data) => reject(new Error(String(data))));
      })));
      expect(paths[0]).not.toBe(paths[1]);
      expect(() => manager(path, 100, 2).create(1)).toThrow("quota");
      const exited = new Promise((resolve) => children[0].once("close", resolve));
      children[0].stdin.write("exit"); await exited;
      expect(existsSync(paths[0])).toBe(false);
      expect(existsSync(paths[1])).toBe(true);
      manager(path, 100, 2).create(1).discard();
      expect(existsSync(paths[1])).toBe(true);
    } finally {
      await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => {
        child.once("close", resolve); child.stdin.write("exit");
      })));
    }
  });

  it("orderly child exit cleans its session without installing signal handlers", async () => {
    const path = root();
    const code = `import { tempOutputManager } from './source/utils/temp-output.ts';
      const before = process.listenerCount('SIGINT');
      const capture = tempOutputManager.create(10); capture.write(Buffer.from('test'));
      console.log(JSON.stringify({path: capture.publish(), before, after: process.listenerCount('SIGINT')}));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...process.env, TMPDIR: path } });
    let output = ""; let errors = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { errors += data; });
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect(errors).toBe(""); expect(status).toBe(0);
    const result = JSON.parse(output);
    expect(result.before).toBe(result.after);
    expect(existsSync(result.path)).toBe(false);
  });
});
